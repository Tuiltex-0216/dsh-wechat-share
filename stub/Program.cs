using Windows.ApplicationModel;

namespace WeChatShare.Stub;

/// <summary>
/// ShareTarget entry point. Roles:
///  - --registration-check : print package identity JSON (installer probe)
///  - --selftest &lt;zip...&gt;   : validation + commit without share reporting
///  - (default)             : handle the share activation end to end
/// </summary>
public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "--registration-check")
            {
                RegistrationCheck();
                return 0;
            }
            if (args.Length > 1 && args[0] == "--selftest")
            {
                return await SelfTestAsync(args[1..]);
            }
            if (args.Length > 2 && args[0] == "--gen-assets")
            {
                AssetGen.WriteLogos(args[1], args[2]);
                return 0;
            }
            if (args.Length > 0 && args[0] == "--wake-probe")
            {
                var (exe, diag) = DshWake.ResolveExePath();
                Console.WriteLine($"wake-probe: exe={exe ?? "null"}");
                Console.WriteLine($"wake-probe: {diag}");
                return exe is null ? 1 : 0;
            }
            return await HandleActivationAsync();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[wxshare-stub] fatal: " + ex.Message);
            return 1;
        }
    }

    /// <summary>Installer identity probe: package full name + share AUMID.</summary>
    private static void RegistrationCheck()
    {
        try
        {
            var pkg = Package.Current;
            var full = pkg.Id.FullName;
            var aumid = pkg.Id.FamilyName + "!Share.Hub";
            Console.WriteLine($"{{\"PackageFullName\":\"{full}\",\"ApplicationUserModelId\":\"{aumid}\"}}");
        }
        catch
        {
            Console.WriteLine("{\"packageIdentity\":null}");
        }
    }

    private static async Task<int> SelfTestAsync(string[] paths)
    {
        var files = paths
            .Select(p => new SharedFile(p, System.IO.Path.GetFileName(p), null))
            .ToList();
        var reject = ShareActivation.ValidateZipPayload(files);
        if (reject is not null)
        {
            Console.Error.WriteLine(reject);
            return 1;
        }
        var paths1 = InboxPaths.Default();
        var commitFiles = new List<(string Path, string Name, string? ContentType)>();
        foreach (var f in files)
        {
            var (normalizedPath, renames) = ZipNormalizer.Normalize(f.Path, Path.Combine(paths1.InboxRoot, ".wxnorm"));
            if (renames.Count > 0)
                Console.Error.WriteLine($"[wxshare-stub] normalized {renames.Count} extension(s): {string.Join("; ", renames)}");
            commitFiles.Add((normalizedPath, f.Name, f.ContentType));
        }
        var committed = await InboxWriter.CommitAsync(paths1, commitFiles);
        Console.WriteLine($"selftest committed {committed.BatchId} at {committed.BatchDirectory}");
        return 0;
    }

    private static async Task<int> HandleActivationAsync()
    {
        if (!ShareActivation.TryReadActivation(out var shareArgs) || shareArgs is null)
        {
            // Not launched by the share host (unpackaged run, stray launch): no-op.
            return 0;
        }

        var operation = shareArgs.ShareOperation;
        ShareReports.Started(operation);
        try
        {
            var files = await ShareActivation.ReadFilesAsync(shareArgs);
            var reject = ShareActivation.ValidateZipPayload(files);
            if (reject is not null)
            {
                ShareReports.Failed(operation, reject);
                return 1;
            }

            // WeChat misnames media entries (PNG/HEIC bytes as ".jpg") —
            // normalize extensions by magic bytes before the zip is archived.
            // WeChat stages share files in Temp\WeixinShare\Placeholders — a
            // directory the stub cannot write to — so Normalize falls back to
            // a temp copy under the inbox when in-place swap is denied.
            // Commit uses the (possibly temp) path; temp files are cleaned
            // up after the commit copies their bytes.
            var paths = InboxPaths.Default();
            var normFallbackDir = Path.Combine(paths.InboxRoot, ".wxnorm");
            var commitFiles = new List<(string Path, string Name, string? ContentType)>();
            var tempArtifacts = new List<string>();
            foreach (var f in files)
            {
                var usePath = f.Path;
                try
                {
                    var (normalizedPath, renames) = ZipNormalizer.Normalize(f.Path, normFallbackDir);
                    if (renames.Count > 0)
                    {
                        var isTempCopy = Path.GetFullPath(normalizedPath) != Path.GetFullPath(f.Path);
                        var mode = isTempCopy ? "temp-copy" : "in-place";
                        InboxWriter.Log(paths, $"normalized {renames.Count} extension(s) in {f.Name} [{mode}]: {string.Join("; ", renames)}");
                        usePath = normalizedPath;
                        if (isTempCopy)
                            tempArtifacts.Add(normalizedPath);
                    }
                }
                catch (Exception normEx)
                {
                    // normalization is best-effort — a broken zip still ships
                    // (the receiver sees the original names)
                    InboxWriter.Log(paths, $"normalize failed for {f.Name}: {normEx.Message}");
                }
                commitFiles.Add((usePath, f.Name, f.ContentType));
            }

            var committed = await InboxWriter.CommitAsync(paths, commitFiles);
            foreach (var t in tempArtifacts)
            {
                try { File.Delete(t); } catch { /* best effort */ }
            }
            ShareReports.DataRetrieved(operation);
            ShareReports.Completed(operation);
            InboxWriter.Log(paths, $"share committed {committed.BatchId} files={committed.Manifest.Items.Count}");

            // behavior c (user-chosen): silent queue. The batch is durable in
            // the inbox; the DSH plugin's startup sweep surfaces it (overlay)
            // the next time DSH runs. Wake-on-share is NOT attempted: the
            // share target runs at medium IL (OS-mandated for plain-exe
            // share targets) and cannot launch external processes — and wake
            // is only needed when DSH is closed, exactly the blocked case.
            // (DshWake/--wake-probe remain available for diagnostics and a
            // future resident full-trust helper.)
            InboxWriter.Log(paths, "queued for DSH startup sweep (silent-queue behavior; wake is medium-IL-blocked)");
            return 0;
        }
        catch (Exception ex)
        {
            ShareReports.Failed(operation, ex.Message);
            InboxWriter.Log(InboxPaths.Default(), $"share failed: {ex.Message}");
            return 1;
        }
    }
}
