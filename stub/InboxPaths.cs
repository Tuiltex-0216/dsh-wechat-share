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

    public static InboxPaths Default() => new()
    {
        Root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "dsh-desktop", "harness", "wxshare"),
    };

    /// <summary>Test/override constructor: any root directory.</summary>
    public static InboxPaths ForRoot(string root) => new() { Root = Path.GetFullPath(root) };
}
