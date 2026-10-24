using System.IO.Compression;
using System.Text;

namespace WeChatShare.Stub;

/// <summary>
/// Normalizes media entry extensions inside WeChat chat-record zips by
/// magic bytes. WeChat's consolidated forward guesses extensions: real
/// payloads routinely contain PNG (and HEIC/WebP) bytes named ".jpg", which
/// breaks extension-keyed image readers on the receiving side. Text entries
/// (.txt/.html), videos (mp4/mov ftyp brands), and unknown formats are left
/// untouched. Returns a human-readable report of every rename applied
/// ("old → new"); empty when nothing needed fixing.
/// </summary>
public static class ZipNormalizer
{
    /// <summary>
    /// Magic-byte sniff → canonical extension, or null when the bytes do not
    /// identify a correctable image format.
    /// </summary>
    public static string? SniffExtension(byte[] head)
    {
        if (head is null) return null;
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (head.Length >= 8 && head[0] == 0x89 && head[1] == 0x50 && head[2] == 0x4E && head[3] == 0x47
            && head[4] == 0x0D && head[5] == 0x0A && head[6] == 0x1A && head[7] == 0x0A)
            return "png";
        // JPEG: FF D8 FF
        if (head.Length >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF)
            return "jpg";
        // WebP: RIFF????WEBP
        if (head.Length >= 12 && head[0] == (byte)'R' && head[1] == (byte)'I' && head[2] == (byte)'F' && head[3] == (byte)'F'
            && head[8] == (byte)'W' && head[9] == (byte)'E' && head[10] == (byte)'B' && head[11] == (byte)'P')
            return "webp";
        // GIF: GIF87a / GIF89a
        if (head.Length >= 6 && head[0] == (byte)'G' && head[1] == (byte)'I' && head[2] == (byte)'F' && head[3] == (byte)'8')
            return "gif";
        // BMP: BM
        if (head.Length >= 2 && head[0] == (byte)'B' && head[1] == (byte)'M')
            return "bmp";
        // ISO-BMFF (ftyp box): only IMAGE brands are corrected — video brands
        // (isom/mp42/dash/mov…) share the container and must stay untouched.
        if (head.Length >= 12 && head[4] == (byte)'f' && head[5] == (byte)'t' && head[6] == (byte)'y' && head[7] == (byte)'p')
        {
            var brand = Encoding.ASCII.GetString(head, 8, 4);
            return brand switch
            {
                "heic" or "heix" or "mif1" or "msf1" => "heic",
                "png " => "png", // PNG can ride in a BMFF container
                _ => null,
            };
        }
        return null;
    }

    /// <summary>
    /// Rewrites a zip so every image entry carries its true extension.
    /// Entries are renamed within their folder; name collisions get a
    /// "_1", "_2"… suffix. Returns (pathToCommit, report): in-place swap
    /// when the zip's directory is writable, otherwise a temp copy under
    /// <paramref name="fallbackDir"/> (the original stays untouched —
    /// WeChat owns its placeholder files). Empty report = nothing to fix,
    /// pathToCommit = the original path.
    /// </summary>
    public static (string Path, IReadOnlyList<string> Report) Normalize(string zipPath, string fallbackDir)
    {
        var report = new List<string>();

        // Phase 1: plan the renames (collision-safe against existing names).
        // Keyed by entry ordinal — the ZipArchiveEntry reference stays valid
        // only while the archive is open, and the rebuild phase needs the
        // source closed before the Windows file swap.
        var existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var plan = new List<(int Index, string Old, string New)>();
        var order = new List<string>();
        using (var source = ZipFile.OpenRead(zipPath))
        {
            foreach (var e in source.Entries) existing.Add(e.FullName);
            int i = 0;
            foreach (var entry in source.Entries)
            {
                order.Add(entry.FullName);
                var ext = Path.GetExtension(entry.FullName);
                if (ext.Length > 0)
                {
                    ext = ext.ToLowerInvariant();
                    if (ext is (".png" or ".jpg" or ".jpeg" or ".webp" or ".heic" or ".gif" or ".bmp"))
                    {
                        byte[] head;
                        using (var s = entry.Open())
                        {
                            var buf = new byte[64];
                            var n = s.Read(buf, 0, buf.Length);
                            head = buf.AsSpan(0, Math.Min(n, 16)).ToArray();
                        }
                        var trueExt = SniffExtension(head);
                        if (trueExt is not null)
                        {
                            var canonical = "." + trueExt;
                            var alreadyCorrect = ext == canonical
                                || (ext is ".jpg" or ".jpeg" && canonical is ".jpg" or ".jpeg");
                            if (!alreadyCorrect)
                            {
                                var dirPart = Path.GetDirectoryName(entry.FullName) ?? string.Empty;
                                var baseName = Path.GetFileNameWithoutExtension(entry.FullName);
                                var candidate = Combine(dirPart, baseName + canonical);
                                int suffix = 1;
                                while (existing.Contains(candidate) || plan.Any(p => p.New == candidate))
                                {
                                    candidate = Combine(dirPart, $"{baseName}_{suffix++}{canonical}");
                                }
                                plan.Add((i, entry.FullName, candidate));
                            }
                        }
                    }
                }
                i++;
            }
        }
        if (plan.Count == 0) return (zipPath, report);

        // Phase 2a: try IN-PLACE (temp file beside the zip, then swap).
        // WeChat's share placeholders (Temp\WeixinShare\Placeholders) are
        // write-denied to the stub — that failure is expected and handled
        // by the fallback below.
        var tempPath = zipPath + ".wxnorm-" + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Rebuild(zipPath, tempPath, plan, report);
            File.Move(tempPath, zipPath, overwrite: true);
            return (zipPath, report);
        }
        catch (Exception inPlaceEx) when (inPlaceEx is IOException or UnauthorizedAccessException)
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { /* best effort */ }
            // Phase 2a's Rebuild already filled the report — reset it so the
            // fallback rebuild does not double-record.
            report.Clear();
            // Phase 2b: fallback — rebuild into the caller-supplied writable
            // dir (under the inbox); the ORIGINAL placeholder file is left
            // untouched (WeChat owns it).
            Directory.CreateDirectory(fallbackDir);
            var fallbackPath = Path.Combine(fallbackDir, "wxnorm-" + Guid.NewGuid().ToString("N") + "-" + Path.GetFileName(zipPath));
            Rebuild(zipPath, fallbackPath, plan, report);
            return (fallbackPath, report);
        }
    }

    private static void Rebuild(string sourceZip, string targetZip,
        List<(int Index, string Old, string New)> plan, List<string> report)
    {
        // source is CLOSED during the rebuild (Windows refuses to swap a
        // file still locked by an open archive — the rebuild reopens it read-only)
        using (var target = ZipFile.Open(targetZip, ZipArchiveMode.Create))
        using (var source = ZipFile.OpenRead(sourceZip))
        {
            int i = 0;
            foreach (var entry in source.Entries)
            {
                var rename = plan.FirstOrDefault(p => p.Index == i);
                var newName = rename.New is not null ? rename.New : entry.FullName;
                var newEntry = target.CreateEntry(newName, CompressionLevel.Optimal);
                using var srcStream = entry.Open();
                using var dstStream = newEntry.Open();
                srcStream.CopyTo(dstStream);
                if (rename.New is not null) report.Add($"{rename.Old} → {rename.New}");
                i++;
            }
        }
    }

    private static string Combine(string dir, string name)
        => string.IsNullOrEmpty(dir) ? name : dir + "/" + name;
}
