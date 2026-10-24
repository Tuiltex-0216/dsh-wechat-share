using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace WeChatShare.Stub;

/// <summary>
/// Generates the MSIX share-target logos (Square44x44 / Square150x150) from
/// the DSH app icon: center-crop to square, high-quality bicubic scale.
/// </summary>
public static class AssetGen
{
    public static void WriteLogos(string sourcePng, string outputDir)
    {
        if (!File.Exists(sourcePng))
            throw new FileNotFoundException("source icon not found", sourcePng);
        Directory.CreateDirectory(outputDir);
        using var src = Image.FromFile(sourcePng);
        WriteScaled(src, Path.Combine(outputDir, "Square44x44Logo.png"), 44);
        WriteScaled(src, Path.Combine(outputDir, "Square150x150Logo.png"), 150);
    }

    private static void WriteScaled(Image src, string dest, int size)
    {
        using var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.SmoothingMode = SmoothingMode.HighQuality;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.CompositingQuality = CompositingQuality.HighQuality;
        var side = Math.Min(src.Width, src.Height);
        var srcRect = new Rectangle((src.Width - side) / 2, (src.Height - side) / 2, side, side);
        g.DrawImage(src, new Rectangle(0, 0, size, size), srcRect, GraphicsUnit.Pixel);
        bmp.Save(dest, ImageFormat.Png);
    }
}
