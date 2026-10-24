using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.ApplicationModel.DataTransfer;
using Windows.ApplicationModel.DataTransfer.ShareTarget;
using Windows.Storage;

namespace WeChatShare.Stub;

/// <summary>One shared file as handed over by the Windows share host.</summary>
public sealed record SharedFile(string Path, string Name, string? ContentType);

/// <summary>Raised when a share payload is rejected before commit.</summary>
public sealed class SharePayloadException : Exception
{
    public SharePayloadException(string message) : base(message) { }
}

/// <summary>
/// WinRT share-activation surface. Everything here is thin over the projected
/// WinRT types; the pure logic (validation) is unit-tested, the activation
/// probe is exercised in e2e (T10) because it needs a real MSIX identity.
/// </summary>
public static class ShareActivation
{
    /// <summary>
    /// True when this process was launched by the share host with a
    /// ShareTarget activation. Unpackaged launches (or non-share activations)
    /// return false and never throw — a share must not crash on a no-op launch.
    /// </summary>
    public static bool TryReadActivation(out IShareTargetActivatedEventArgs? shareArgs)
    {
        shareArgs = null;
        try
        {
            var args = AppInstance.GetActivatedEventArgs();
            if (args is not IShareTargetActivatedEventArgs share)
                return false;
            shareArgs = share;
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Flatten the share's StorageItems into readable files.</summary>
    public static async Task<IReadOnlyList<SharedFile>> ReadFilesAsync(IShareTargetActivatedEventArgs args)
    {
        var operation = args.ShareOperation;
        if (!operation.Data.Contains(StandardDataFormats.StorageItems))
            throw new SharePayloadException("只接收文件型分享。");

        var items = await operation.Data.GetStorageItemsAsync();
        var files = new List<SharedFile>(items.Count);
        foreach (var item in items)
        {
            if (item is not StorageFile file)
                throw new SharePayloadException("分享项不是可读取的文件。");
            if (string.IsNullOrWhiteSpace(file.Path))
                throw new SharePayloadException($"无法读取分享文件：{file.Name}");
            files.Add(new SharedFile(file.Path, file.Name, file.ContentType));
        }
        return files;
    }

    /// <summary>
    /// Accept only WeChat chat-record zips. Returns null when the payload is
    /// usable, otherwise the exact rejection message to surface to the sharer.
    /// </summary>
    public static string? ValidateZipPayload(IReadOnlyList<SharedFile> files)
    {
        if (files is null || files.Count == 0)
            return "分享中没有文件。";
        foreach (var f in files)
        {
            if (!f.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
                return "只接收微信聊天记录 ZIP（.zip）。";
        }
        return null;
    }
}
