using WeChatShare.Stub;
using Xunit;

namespace WeChatShare.Stub.Tests;

/// <summary>
/// T2 — share activation: zip payload validation + unpackaged probe behavior.
/// WinRT activation itself (ShareOperation) is only exercised in e2e (T10);
/// everything around it is pure and tested here.
/// </summary>
public sealed class ShareActivationTests
{
    private static SharedFile F(string name, string? contentType = "application/x-zip-compressed")
        => new(Path.Combine("C:\\fake\\share", name), name, contentType);

    [Fact]
    public void ValidateZipPayload_Empty_ReturnsNoFilesMsg()
    {
        var msg = ShareActivation.ValidateZipPayload(Array.Empty<SharedFile>());
        Assert.Equal("分享中没有文件。", msg);
    }

    [Fact]
    public void ValidateZipPayload_NonZip_ReturnsZipOnlyMsg()
    {
        var msg = ShareActivation.ValidateZipPayload(new[] { F("a.zip"), F("b.txt", "text/plain") });
        Assert.Equal("只接收微信聊天记录 ZIP（.zip）。", msg);
    }

    [Fact]
    public void ValidateZipPayload_ZipsOnly_ReturnsNull_CaseInsensitive()
    {
        Assert.Null(ShareActivation.ValidateZipPayload(new[] { F("聊天记录_20261023_214123.zip"), F("UPPER.ZIP") }));
    }

    [Fact]
    public void TryReadActivation_Unpackaged_ReturnsFalse()
    {
        // The test host has no MSIX package identity: AppInstance.GetActivatedEventArgs
        // throws, and the probe must swallow that into `false` (never crash a share).
        var ok = ShareActivation.TryReadActivation(out var args);
        Assert.False(ok);
        Assert.Null(args);
    }
}
