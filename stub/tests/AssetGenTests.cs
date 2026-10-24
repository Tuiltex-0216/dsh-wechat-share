using System.Drawing;
using System.Drawing.Imaging;
using WeChatShare.Stub;
using Xunit;

namespace WeChatShare.Stub.Tests;

/// <summary>T3 — share-target logos generated from the DSH app icon.</summary>
public sealed class AssetGenTests : IDisposable
{
    private readonly string _tmp;

    public AssetGenTests()
    {
        _tmp = Path.Combine(AppContext.BaseDirectory, "wxshare-t3-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tmp);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tmp, recursive: true); } catch { }
    }

    private static void WriteSourcePng(string path, int size = 256)
    {
        using var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.FromArgb(255, 69, 97, 238)); // DSH blue
            g.FillEllipse(Brushes.White, size / 4, size / 4, size / 2, size / 2);
        }
        bmp.Save(path, ImageFormat.Png);
    }

    private static (int W, int H) PngSize(string path)
    {
        using var fs = File.OpenRead(path);
        var buf = new byte[24];
        Assert.Equal(24, fs.Read(buf, 0, 24));
        // PNG: 8-byte sig + IHDR len(4) + "IHDR" + width(4 BE) + height(4 BE)
        Assert.Equal((byte)'I', buf[12]);
        var w = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
        var h = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
        return (w, h);
    }

    [Fact]
    public void WriteLogos_Produces44And150SquarePngs()
    {
        var src = Path.Combine(_tmp, "source.png");
        var outDir = Path.Combine(_tmp, "assets");
        WriteSourcePng(src);

        AssetGen.WriteLogos(src, outDir);

        var logo44 = Path.Combine(outDir, "Square44x44Logo.png");
        var logo150 = Path.Combine(outDir, "Square150x150Logo.png");
        Assert.True(File.Exists(logo44));
        Assert.True(File.Exists(logo150));
        Assert.Equal((44, 44), PngSize(logo44));
        Assert.Equal((150, 150), PngSize(logo150));
    }

    [Fact]
    public void WriteLogos_MissingSource_Throws()
    {
        var outDir = Path.Combine(_tmp, "assets2");
        Assert.Throws<FileNotFoundException>(() => AssetGen.WriteLogos(Path.Combine(_tmp, "nope.png"), outDir));
    }
}
