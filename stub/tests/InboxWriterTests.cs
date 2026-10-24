using System.Text;
using WeChatShare.Stub;
using Xunit;

namespace WeChatShare.Stub.Tests;

/// <summary>
/// T1 — inbox contract: atomic batch commit + manifest JSON shape.
/// The manifest field names are a cross-language contract with the DSH
/// plugin host half (plugin/lib/inbox.js reads lowercase camelCase keys),
/// so the casing tests are load-bearing, not stylistic.
/// </summary>
public sealed class InboxWriterTests : IDisposable
{
    private readonly string _tmpRoot;

    public InboxWriterTests()
    {
        // Scratch under the test assembly dir (workspace-writable; %TEMP% is
        // not reachable from sandboxed child processes on this host).
        _tmpRoot = Path.Combine(AppContext.BaseDirectory, "wxshare-t1-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tmpRoot);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tmpRoot, recursive: true); } catch { /* best effort */ }
    }

    private InboxPaths Paths() => InboxPaths.ForRoot(_tmpRoot);

    private static string MakeSourceFile(string dir, string name, byte[] content)
    {
        var p = Path.Combine(dir, name);
        File.WriteAllBytes(p, content);
        return p;
    }

    [Fact]
    public async Task Commit_ProducesReadyBatch_WithManifestAndFiles()
    {
        var paths = Paths();
        var src = Path.Combine(_tmpRoot, "src");
        Directory.CreateDirectory(src);
        var a = MakeSourceFile(src, "聊天记录_a.zip", Encoding.UTF8.GetBytes("alpha-bytes"));
        var b = MakeSourceFile(src, "聊天记录_b.zip", new byte[] { 1, 2, 3, 4 });

        var committed = await InboxWriter.CommitAsync(paths, new (string, string, string?)[]
        {
            (a, "聊天记录_a.zip", "application/x-zip-compressed"),
            (b, "聊天记录_b.zip", null),
        });

        // Ready layout
        Assert.Equal(Path.Combine(paths.ReadyDir, committed.BatchId.ToString()), committed.BatchDirectory);
        Assert.True(Directory.Exists(committed.BatchDirectory));

        // Manifest parseable + fields
        var manifestPath = Path.Combine(committed.BatchDirectory, "manifest.json");
        Assert.True(File.Exists(manifestPath));
        var manifest = InboxManifest.FromJson(File.ReadAllText(manifestPath));
        Assert.Equal(1, manifest.SchemaVersion);
        Assert.Equal(committed.BatchId, manifest.BatchId);
        Assert.Equal("wechat-share", manifest.Source);
        Assert.Equal(2, manifest.Items.Count); // two items by construction
        Assert.Equal("files/聊天记录_a.zip", manifest.Items[0].RelativePath);
        Assert.Equal(11, manifest.Items[0].Size);
        Assert.Equal("application/x-zip-compressed", manifest.Items[0].ContentType);
        Assert.Null(manifest.Items[1].ContentType);

        // File bytes intact
        var fileA = Path.Combine(committed.BatchDirectory, "files", "聊天记录_a.zip");
        Assert.Equal("alpha-bytes", File.ReadAllText(fileA));
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, File.ReadAllBytes(Path.Combine(committed.BatchDirectory, "files", "聊天记录_b.zip")));
    }

    [Fact]
    public async Task Commit_StagingLeavesNoResidue()
    {
        var paths = Paths();
        var src = Path.Combine(_tmpRoot, "src");
        Directory.CreateDirectory(src);
        var a = MakeSourceFile(src, "x.zip", new byte[] { 9 });

        var committed = await InboxWriter.CommitAsync(paths, new (string, string, string?)[] { (a, "x.zip", null) });

        var leftovers = Directory.Exists(paths.StagingDir)
            ? Directory.GetDirectories(paths.StagingDir).Where(d => d.Contains(committed.BatchId.ToString())).ToList()
            : new List<string>();
        Assert.Empty(leftovers);
    }

    [Fact]
    public async Task Commit_ConcurrentBatches_DoNotCollide()
    {
        var paths = Paths();
        var src = Path.Combine(_tmpRoot, "src");
        Directory.CreateDirectory(src);
        var a = MakeSourceFile(src, "one.zip", new byte[] { 1 });
        var b = MakeSourceFile(src, "two.zip", new byte[] { 2 });

        var results = await Task.WhenAll(
            InboxWriter.CommitAsync(paths, new (string, string, string?)[] { (a, "one.zip", null) }),
            InboxWriter.CommitAsync(paths, new (string, string, string?)[] { (b, "two.zip", null) }));
        var (c1, c2) = (results[0], results[1]);

        Assert.NotEqual(c1.BatchId, c2.BatchId);
        Assert.True(Directory.Exists(c1.BatchDirectory));
        Assert.True(Directory.Exists(c2.BatchDirectory));
        Assert.Single(Directory.GetFiles(Path.Combine(c1.BatchDirectory, "files")));
        Assert.Single(Directory.GetFiles(Path.Combine(c2.BatchDirectory, "files")));
    }

    [Fact]
    public void Manifest_RoundTrips_Json()
    {
        var original = new InboxManifest
        {
            SchemaVersion = 1,
            BatchId = Guid.NewGuid(),
            CreatedAt = new DateTimeOffset(2026, 10, 23, 12, 34, 56, 789, TimeSpan.Zero),
            Source = "wechat-share",
            Items =
            {
                new InboxManifest.Item { Name = "m.zip", RelativePath = "files/m.zip", Size = 42, ContentType = "application/x-zip-compressed" },
            },
        };

        var restored = InboxManifest.FromJson(original.ToJson());
        Assert.Equal(original.SchemaVersion, restored.SchemaVersion);
        Assert.Equal(original.BatchId, restored.BatchId);
        Assert.Equal(original.Source, restored.Source);
        Assert.Single(restored.Items);
        Assert.Equal("m.zip", restored.Items[0].Name);
        Assert.Equal("files/m.zip", restored.Items[0].RelativePath);
        Assert.Equal(42, restored.Items[0].Size);
        Assert.Equal("application/x-zip-compressed", restored.Items[0].ContentType);
    }

    [Fact]
    public void Manifest_Json_UsesContractLowerCaseKeys()
    {
        // Cross-language contract (Global Constraints): the DSH plugin host
        // half parses these exact lowercase keys from manifest.json.
        var json = new InboxManifest
        {
            SchemaVersion = 1,
            BatchId = Guid.NewGuid(),
            CreatedAt = DateTimeOffset.UtcNow,
            Source = "wechat-share",
            Items = { new InboxManifest.Item { Name = "n.zip", RelativePath = "files/n.zip", Size = 1, ContentType = null } },
        }.ToJson();

        Assert.Contains("\"schemaVersion\"", json);
        Assert.Contains("\"batchId\"", json);
        Assert.Contains("\"createdAt\"", json);
        Assert.Contains("\"source\"", json);
        Assert.Contains("\"relativePath\"", json);
        Assert.Contains("\"contentType\"", json);
        Assert.DoesNotContain("\"RelativePath\"", json);
        Assert.DoesNotContain("\"SchemaVersion\"", json);
    }
}
