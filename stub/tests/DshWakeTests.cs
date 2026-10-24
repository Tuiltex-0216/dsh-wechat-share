using WeChatShare.Stub;
using Xunit;

namespace WeChatShare.Stub.Tests;

/// <summary>
/// T4-wake — DSH Desktop launch resolution. The registry scan is
/// environment-dependent; the Program Files fallback is deterministic on
/// any machine with DSH Desktop installed (this one is).
/// </summary>
public sealed class DshWakeTests
{
    [Fact]
    public void ResolveExePath_FindsInstalledDsh()
    {
        var exe = DshWake.ResolveExePath();
        Assert.NotNull(exe);
        Assert.EndsWith("DSH Desktop.exe", exe!);
        Assert.True(File.Exists(exe), $"exe not on disk: {exe}");
    }
}
