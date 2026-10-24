namespace WeChatShare.Stub;

/// <summary>
/// Fixed layout under one root. Default root colocates with DSH state:
/// %APPDATA%\dsh-desktop\harness\wxshare (== $DSH_HOME\wxshare).
/// </summary>
public sealed record InboxPaths
{
    public required string Root { get; init; }

    public string InboxRoot => Path.Combine(Root, "inbox");
    public string StagingDir => Path.Combine(InboxRoot, "Staging");
    public string ReadyDir => Path.Combine(InboxRoot, "Ready");
    public string DoneDir => Path.Combine(InboxRoot, "Done");
    public string LogsDir => Path.Combine(Root, "logs");

    /// <summary>
    /// Default root: %APPDATA%\dsh-desktop\harness\wxshare. The WXSHARE_ROOT
    /// environment override exists so sandboxed test/selftest runs (and CI)
    /// can point the inbox at a writable location without touching product
    /// layout; production launches by the share host never set it.
    /// </summary>
    public static InboxPaths Default()
    {
        var overrideRoot = Environment.GetEnvironmentVariable("WXSHARE_ROOT");
        return new()
        {
            Root = string.IsNullOrWhiteSpace(overrideRoot)
                ? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "dsh-desktop", "harness", "wxshare")
                : Path.GetFullPath(overrideRoot),
        };
    }

    /// <summary>Test/override constructor: any root directory.</summary>
    public static InboxPaths ForRoot(string root) => new() { Root = Path.GetFullPath(root) };
}
