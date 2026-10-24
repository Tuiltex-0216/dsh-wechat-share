using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WeChatShare.Stub;

/// <summary>
/// inbox manifest contract (Global Constraints — cross-language with the DSH
/// plugin host half, which parses these exact lowercase keys):
/// {schemaVersion:1, batchId, createdAt(ISO-8601 UTC Z), source:"wechat-share",
///  items:[{name, relativePath, size, contentType}]}
/// </summary>
public sealed class InboxManifest
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; } = 1;

    [JsonPropertyName("batchId")]
    public Guid BatchId { get; set; }

    [JsonPropertyName("createdAt")]
    [JsonConverter(typeof(UtcZDateTimeConverter))]
    public DateTimeOffset CreatedAt { get; set; }

    [JsonPropertyName("source")]
    public string Source { get; set; } = "wechat-share";

    [JsonPropertyName("items")]
    public List<Item> Items { get; set; } = new();

    public sealed class Item
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("relativePath")]
        public string RelativePath { get; set; } = "";

        [JsonPropertyName("size")]
        public long Size { get; set; }

        [JsonPropertyName("contentType")]
        public string? ContentType { get; set; }
    }

    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
    };

    public string ToJson() => JsonSerializer.Serialize(this, Options);

    public static InboxManifest FromJson(string json) =>
        JsonSerializer.Deserialize<InboxManifest>(json, Options)
        ?? throw new InvalidDataException("manifest.json deserialized to null");

    /// <summary>
    /// ISO-8601 UTC with a literal Z suffix (the manifest contract), instead of
    /// System.Text.Json's default "+00:00" offset form.
    /// </summary>
    private sealed class UtcZDateTimeConverter : JsonConverter<DateTimeOffset>
    {
        public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
            => DateTimeOffset.Parse(reader.GetString()!, CultureInfo.InvariantCulture);

        public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options)
            => writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture));
    }
}
