using Windows.ApplicationModel.DataTransfer.ShareTarget;

namespace WeChatShare.Stub;

/// <summary>
/// ShareOperation progress reports, advisory and single-shot: a duplicate
/// report throws, so every call is swallowed. A reporting failure must never
/// kill an otherwise successful share (mirrors WeChatBridge's ShareReports).
/// </summary>
public static class ShareReports
{
    public static void Started(ShareOperation operation) => Safe(() => operation.ReportStarted());
    public static void DataRetrieved(ShareOperation operation) => Safe(() => operation.ReportDataRetrieved());
    public static void Completed(ShareOperation operation) => Safe(() => operation.ReportCompleted());
    public static void Failed(ShareOperation operation, string? message)
        => Safe(() => operation.ReportError(message ?? "分享处理失败。"));

    private static void Safe(Action action)
    {
        try { action(); } catch { /* advisory only */ }
    }
}
