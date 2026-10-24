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
        foreach (var f in files)
        {
            var renames = ZipNormalizer.Normalize(f.Path);
            if (renames.Count > 0)
                Console.Error.WriteLine($"[wxshare-stub] normalized {renames.Count} extension(s): {string.Join("; ", renames)}");
        }
        var paths1 = InboxPaths.Default();
        var committed = await InboxWriter.CommitAsync(paths1,
            files.Select(f => (f.Path, f.Name, (string?)f.ContentType)).ToList());
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
            foreach (var f in files)
            {
                try
                {
                    var renames = ZipNormalizer.Normalize(f.Path);
                    if (renames.Count > 0)
                        InboxWriter.Log(InboxPaths.Default(), $"normalized {renames.Count} extension(s) in {f.Name}: {string.Join("; ", renames)}");
                }
                catch (Exception normEx)
                {
                    // normalization is best-effort — a broken zip still ships
                    // (the receiver sees the original names)
                    InboxWriter.Log(InboxPaths.Default(), $"normalize failed for {f.Name}: {normEx.Message}");
                }
            }

            var paths = InboxPaths.Default();
            var committed = await InboxWriter.CommitAsync(paths,
                files.Select(f => (f.Path, f.Name, (string?)f.ContentType)).ToList());
            ShareReports.DataRetrieved(operation);
            ShareReports.Completed(operation);
            InboxWriter.Log(paths, $"share committed {committed.BatchId} files={committed.Manifest.Items.Count}");

            // behavior c (user-chosen): wake DSH so the overlay appears.
            // If DSH is already running with a window, the second instance
            // exits via the single-instance lock after promoting the window.
            if (DshWake.Wake())
                InboxWriter.Log(paths, "dsh wake launched");
            else
                InboxWriter.Log(paths, "dsh wake unavailable (exe not found) — batch queued silently");
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
