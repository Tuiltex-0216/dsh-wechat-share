namespace WeChatShare.Stub;

public sealed class BatchCollisionException : Exception
{
    public Guid BatchId { get; }
    public BatchCollisionException(Guid batchId)
        : base($"Ready batch already exists: {batchId}") => BatchId = batchId;
}

public sealed record CommittedBatch(Guid BatchId, string BatchDirectory, InboxManifest Manifest);

/// <summary>
/// Atomic batch commit: stage under Staging\<guid>.staging, copy files,
/// write manifest.json last, then rename the whole directory to Ready\<guid>.
/// A batch is visible to consumers only once complete.
/// </summary>
public static class InboxWriter
{
    public static async Task<CommittedBatch> CommitAsync(
        InboxPaths paths,
        IReadOnlyList<(string SourcePath, string Name, string? ContentType)> sources,
        CancellationToken ct = default)
    {
        if (sources is null || sources.Count == 0)
            throw new ArgumentException("at least one source is required", nameof(sources));

        var batchId = Guid.NewGuid();
        Directory.CreateDirectory(paths.ReadyDir);
        Directory.CreateDirectory(paths.StagingDir);

        var staging = Path.Combine(paths.StagingDir, batchId + ".staging");
        var filesDir = Path.Combine(staging, "files");
        Directory.CreateDirectory(filesDir);

        try
        {
            var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var items = new List<InboxManifest.Item>(sources.Count);

            foreach (var (sourcePath, name, contentType) in sources)
            {
                ct.ThrowIfCancellationRequested();
                var safeName = UniqueName(SanitizeFileName(name), usedNames);
                var dest = Path.Combine(filesDir, safeName);
                await using (var src = File.OpenRead(sourcePath))
                await using (var dst = File.Create(dest))
                {
                    await src.CopyToAsync(dst, 64 * 1024, ct);
                }
                items.Add(new InboxManifest.Item
                {
                    Name = safeName,
                    RelativePath = "files/" + safeName,
                    Size = new FileInfo(dest).Length,
                    ContentType = contentType,
                });
            }

            var manifest = new InboxManifest
            {
                SchemaVersion = 1,
                BatchId = batchId,
                CreatedAt = DateTimeOffset.UtcNow,
                Source = "wechat-share",
                Items = items,
            };
            File.WriteAllText(Path.Combine(staging, "manifest.json"), manifest.ToJson());

            var target = Path.Combine(paths.ReadyDir, batchId.ToString());
            if (Directory.Exists(target))
                throw new BatchCollisionException(batchId);
            Directory.Move(staging, target);

            Log(paths, $"committed batch {batchId} files={items.Count}");
            return new CommittedBatch(batchId, target, manifest);
        }
        catch
        {
            try { if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true); } catch { /* best effort */ }
            throw;
        }
    }

    /// <summary>Strip path separators and invalid filename characters; never yield "." / ".." / empty.</summary>
    internal static string SanitizeFileName(string name)
    {
        var cleaned = string.Concat((name ?? "").Select(c =>
            Path.GetInvalidFileNameChars().Contains(c) ? '_' : c));
        cleaned = cleaned.Trim().Trim('.');
        if (cleaned.Length == 0) cleaned = "file";
        return cleaned;
    }

    internal static string UniqueName(string name, HashSet<string> used)
    {
        if (used.Add(name)) return name;
        var dot = name.LastIndexOf('.');
        var stem = dot > 0 ? name[..dot] : name;
        var ext = dot > 0 ? name[dot..] : "";
        for (var i = 1; ; i++)
        {
            var candidate = $"{stem}-{i}{ext}";
            if (used.Add(candidate)) return candidate;
        }
    }

    internal static void Log(InboxPaths paths, string line)
    {
        try
        {
            Directory.CreateDirectory(paths.LogsDir);
            File.AppendAllText(Path.Combine(paths.LogsDir, "stub.log"),
                $"{DateTimeOffset.UtcNow:O} {line}{Environment.NewLine}");
        }
        catch { /* logging must never break a share */ }
    }
}
