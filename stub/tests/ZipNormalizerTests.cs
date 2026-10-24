using System.IO.Compression;
using WeChatShare.Stub;
using Xunit;

namespace WeChatShare.Stub.Tests;

/// <summary>
/// T10-fix — WeChat chat-record zips misname media files: 18 of 19 ".jpg"
/// entries in a real forward were PNG bytes (WeChat guesses the extension;
/// the payload is often HEIC/WebP too). The receiving agent's image tools
/// key off the extension, so every read failed until manually renamed.
/// The stub normalizes entry extensions by magic bytes before commit.
/// </summary>
public sealed class ZipNormalizerTests
{
    // Workspace-local temp (the session sandbox denies os.tmpdir() writes).
    private static string TempDir()
    {
        var d = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".test-tmp");
        Directory.CreateDirectory(d);
        return d;
    }

    private static byte[] PngBytes() => new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3 };
    private static byte[] JpegBytes() => new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3 };
    private static byte[] WebPBytes()
    {
        var b = new byte[20];
        b[0] = (byte)'R'; b[1] = (byte)'I'; b[2] = (byte)'F'; b[3] = (byte)'F';
        b[8] = (byte)'W'; b[9] = (byte)'E'; b[10] = (byte)'B'; b[11] = (byte)'P';
        return b;
    }
    private static byte[] FtypBytes(string brand)
    {
        var b = new byte[16];
        // size(4) + 'ftyp' + major brand at offset 8
        b[4] = (byte)'f'; b[5] = (byte)'t'; b[6] = (byte)'y'; b[7] = (byte)'p';
        var bb = System.Text.Encoding.ASCII.GetBytes(brand);
        Array.Copy(bb, 0, b, 8, Math.Min(4, bb.Length));
        return b;
    }

    [Theory]
    [InlineData(true)]
    public void Sniff_PngBytes_ReportsPng(bool _)
    {
        Assert.Equal("png", ZipNormalizer.SniffExtension(PngBytes()));
    }

    [Fact]
    public void Sniff_JpegBytes_ReportsJpg()
    {
        Assert.Equal("jpg", ZipNormalizer.SniffExtension(JpegBytes()));
    }

    [Fact]
    public void Sniff_WebPBytes_ReportsWebp()
    {
        Assert.Equal("webp", ZipNormalizer.SniffExtension(WebPBytes()));
    }

    [Fact]
    public void Sniff_HeicFtyp_ReportsHeic()
    {
        Assert.Equal("heic", ZipNormalizer.SniffExtension(FtypBytes("heic")));
        Assert.Equal("heic", ZipNormalizer.SniffExtension(FtypBytes("heix")));
        Assert.Equal("heic", ZipNormalizer.SniffExtension(FtypBytes("mif1")));
    }

    [Fact]
    public void Sniff_VideoFtyp_ReturnsNull()
    {
        // videos share the ftyp container — only image brands are corrected
        Assert.Null(ZipNormalizer.SniffExtension(FtypBytes("isom")));
        Assert.Null(ZipNormalizer.SniffExtension(FtypBytes("mp42")));
        Assert.Null(ZipNormalizer.SniffExtension(FtypBytes("dash")));
    }

    [Fact]
    public void Sniff_GifBmpZip_ReportsCorrectly()
    {
        Assert.Equal("gif", ZipNormalizer.SniffExtension(new byte[] { (byte)'G', (byte)'I', (byte)'F', 0x38, 0x39, 0x61 }));
        Assert.Equal("bmp", ZipNormalizer.SniffExtension(new byte[] { (byte)'B', (byte)'M', 1, 2 }));
        Assert.Null(ZipNormalizer.SniffExtension(new byte[] { 0x50, 0x4B, 0x03, 0x04 })); // nested zip — leave alone
        Assert.Null(ZipNormalizer.SniffExtension(new byte[] { 1, 2, 3 })); // unknown — leave alone
    }

    [Fact]
    public void Normalize_RenamesMisnamedEntries_KeepsContent()
    {
        var dir = Path.Combine(TempDir(), "wxshare-norm-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var zipPath = Path.Combine(dir, "聊天记录_test.zip");
        try
        {
            // build a zip the way WeChat does: media folder, fake .jpg (PNG bytes)
            using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
            {
                WriteEntry(zip, "聊天记录.txt", "·吴\n你好");
                WriteEntry(zip, "聊天记录内的图片、视频和文件/photo1.jpg", PngBytes()); // misnamed
                WriteEntry(zip, "聊天记录内的图片、视频和文件/photo2.jpg", JpegBytes()); // correct
                WriteEntry(zip, "聊天记录内的图片、视频和文件/clip.mp4", FtypBytes("isom")); // video — untouched
            }
            var (resultPath, report) = ZipNormalizer.Normalize(zipPath, Path.Combine(dir, "fallback"));
            Assert.Equal(zipPath, resultPath); // in-place (writable dir)
            Assert.Single(report);
            // full entry paths (forensically useful)
            Assert.Equal("聊天记录内的图片、视频和文件/photo1.jpg → 聊天记录内的图片、视频和文件/photo1.png", report[0]);

            using var check = ZipFile.OpenRead(zipPath);
            var names = check.Entries.Select(e => e.FullName).ToList();
            Assert.Contains("聊天记录内的图片、视频和文件/photo1.png", names);
            Assert.Contains("聊天记录内的图片、视频和文件/photo2.jpg", names);
            Assert.Contains("聊天记录内的图片、视频和文件/clip.mp4", names);
            Assert.DoesNotContain("聊天记录内的图片、视频和文件/photo1.jpg", names);
            // content preserved byte-for-byte
            var pngEntry = check.GetEntry("聊天记录内的图片、视频和文件/photo1.png");
            using var sr = pngEntry!.Open();
            var buf = new byte[64];
            var n = sr.Read(buf, 0, buf.Length);
            Assert.Equal(PngBytes().AsSpan(0, n).ToArray(), buf.AsSpan(0, n).ToArray());
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void Normalize_Collision_AppendsNumericSuffix()
    {
        var dir = Path.Combine(TempDir(), "wxshare-norm-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var zipPath = Path.Combine(dir, "collide.zip");
        try
        {
            using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
            {
                WriteEntry(zip, "media/x.png", PngBytes());   // existing real png
                WriteEntry(zip, "media/x.jpg", PngBytes());   // png bytes → wants x.png → collision
            }
            var (resultPath, report) = ZipNormalizer.Normalize(zipPath, Path.Combine(dir, "fallback"));
            Assert.Equal(zipPath, resultPath);
            Assert.Single(report);
            Assert.True(report[0].Contains("x_1.png"), $"report was: {report[0]}");
            using var check = ZipFile.OpenRead(zipPath);
            var names = check.Entries.Select(e => e.FullName).ToList();
            Assert.Contains("media/x.png", names);
            Assert.Contains("media/x_1.png", names);
            Assert.DoesNotContain("media/x.jpg", names);
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void Normalize_AllCorrect_ReturnsEmptyReport()
    {
        var dir = Path.Combine(TempDir(), "wxshare-norm-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var zipPath = Path.Combine(dir, "clean.zip");
        try
        {
            using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
            {
                WriteEntry(zip, "a.txt", "hello");
                WriteEntry(zip, "media/b.jpg", JpegBytes());
            }
            var (resultPath, report) = ZipNormalizer.Normalize(zipPath, Path.Combine(dir, "fallback"));
            Assert.Equal(zipPath, resultPath);
            Assert.Empty(report);
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    /// <summary>
    /// The WeChat placeholder scenario (exact log evidence: "Access to the
    /// path '...Placeholders\....zip.wxnorm-....tmp' is denied"): the in-place
    /// swap is denied while reads still work. Simulated by holding the zip
    /// open with FileShare.ReadWrite — Phase 1 reads fine, the temp file is
    /// creatable, but File.Move(overwrite) is refused → the exact catch path
    /// that the production denial hits. Normalize must fall back to a temp
    /// copy under fallbackDir, leaving the original untouched.
    /// </summary>
    [Fact]
    public void Normalize_SwapDenied_FallsBackToTempCopy()
    {
        var dir = Path.Combine(TempDir(), "wxshare-norm-" + Guid.NewGuid().ToString("N"));
        var fallback = Path.Combine(TempDir(), "wxshare-norm-fb-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var zipPath = Path.Combine(dir, "held.zip");
        try
        {
            using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
            {
                WriteEntry(zip, "media/pic.jpg", PngBytes()); // misnamed
            }
            // hold the zip open (read sharing allowed, replace denied)
            using var hold = new FileStream(zipPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            var (resultPath, report) = ZipNormalizer.Normalize(zipPath, fallback);
            Assert.Single(report);
            // result is a DIFFERENT file under the fallback dir
            Assert.NotEqual(zipPath, resultPath);
            Assert.True(resultPath.StartsWith(fallback, StringComparison.OrdinalIgnoreCase),
                $"fallback path {resultPath} not under {fallback}");
            Assert.True(File.Exists(resultPath));
            using var check = ZipFile.OpenRead(resultPath);
            var names = check.Entries.Select(e => e.FullName).ToList();
            Assert.Contains("media/pic.png", names);
            Assert.DoesNotContain("media/pic.jpg", names);
            // original untouched (still the misnamed entry)
            using var orig = ZipFile.OpenRead(zipPath);
            Assert.Contains("media/pic.jpg", orig.Entries.Select(e => e.FullName));
        }
        finally
        {
            Directory.Delete(dir, true);
            if (Directory.Exists(fallback)) Directory.Delete(fallback, true);
        }
    }

    private static void WriteEntry(ZipArchive zip, string name, string text)
    {
        var e = zip.CreateEntry(name);
        using var s = e.Open();
        var b = System.Text.Encoding.UTF8.GetBytes(text);
        s.Write(b, 0, b.Length);
    }

    private static void WriteEntry(ZipArchive zip, string name, byte[] bytes)
    {
        var e = zip.CreateEntry(name);
        using var s = e.Open();
        s.Write(bytes, 0, bytes.Length);
    }
}
