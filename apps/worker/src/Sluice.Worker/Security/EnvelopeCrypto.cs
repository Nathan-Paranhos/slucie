using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Sluice.Worker.Configuration;

namespace Sluice.Worker.Security;

public sealed class EnvelopeCrypto
{
    private const int KeyBytes = 32;
    private const int NonceBytes = 12;
    private const int TagBytes = 16;
    private readonly WorkerOptions _options;

    public EnvelopeCrypto(WorkerOptions options) => _options = options;

    public byte[] Decrypt(
        ReadOnlySpan<byte> serializedEnvelope,
        string context,
        int? expectedKeyVersion = null)
    {
        Envelope envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<Envelope>(serializedEnvelope, JsonOptions)
                ?? throw new CryptographicException("The encrypted envelope is empty.");
        }
        catch (JsonException error)
        {
            throw new CryptographicException("The encrypted envelope is malformed.", error);
        }

        ValidateEnvelope(envelope);
        if (expectedKeyVersion is not null && envelope.KeyId != expectedKeyVersion)
        {
            throw new CryptographicException(
                "The database key version does not match the encrypted envelope.");
        }
        if (!_options.MasterKeys.TryGetValue(envelope.KeyId, out var masterKey))
        {
            throw new CryptographicException("The encrypted envelope uses an unavailable key.");
        }

        var dataKey = DecryptPart(
            envelope.WrappedKey,
            masterKey,
            Encoding.UTF8.GetBytes(WrappedKeyAad(envelope.KeyId, context)));
        try
        {
            if (dataKey.Length != KeyBytes)
            {
                throw new CryptographicException("The wrapped data key has an invalid size.");
            }
            return DecryptPart(
                envelope.Data,
                dataKey,
                Encoding.UTF8.GetBytes(PayloadAad(envelope.KeyId, context)));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(dataKey);
        }
    }

    public byte[] Encrypt(ReadOnlySpan<byte> plaintext, string context)
    {
        var masterKey = _options.MasterKeys[_options.ActiveKeyVersion];
        var dataKey = RandomNumberGenerator.GetBytes(KeyBytes);
        try
        {
            var envelope = new Envelope(
                1,
                "A256GCM",
                _options.ActiveKeyVersion,
                EncryptPart(
                    dataKey,
                    masterKey,
                    Encoding.UTF8.GetBytes(
                        WrappedKeyAad(_options.ActiveKeyVersion, context))),
                EncryptPart(
                    plaintext,
                    dataKey,
                    Encoding.UTF8.GetBytes(
                        PayloadAad(_options.ActiveKeyVersion, context))));
            return JsonSerializer.SerializeToUtf8Bytes(envelope, JsonOptions);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(dataKey);
        }
    }

    public static string WebhookBodyContext(
        Guid tenantId,
        Guid sourceId,
        ReadOnlySpan<byte> externalEventIdHash) =>
        $"webhook-event-body:{tenantId:D}:{sourceId:D}:{Convert.ToHexString(externalEventIdHash).ToLowerInvariant()}";

    public static string DestinationContext(Guid tenantId, Guid destinationId) =>
        $"destination-config:{tenantId:D}:{destinationId:D}";

    public static string SourceConfigContext(Guid tenantId, Guid sourceId) =>
        $"webhook-source-config:{tenantId:D}:{sourceId:D}";

    public static string ReconciliationCursorContext(Guid tenantId, Guid sourceId) =>
        $"reconciliation-cursor:{tenantId:D}:{sourceId:D}";

    private static EncryptedPart EncryptPart(
        ReadOnlySpan<byte> plaintext,
        ReadOnlySpan<byte> key,
        ReadOnlySpan<byte> associatedData)
    {
        var nonce = RandomNumberGenerator.GetBytes(NonceBytes);
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[TagBytes];
        using var aes = new AesGcm(key, TagBytes);
        aes.Encrypt(nonce, plaintext, ciphertext, tag, associatedData);
        return new EncryptedPart(
            Convert.ToBase64String(nonce),
            Convert.ToBase64String(ciphertext),
            Convert.ToBase64String(tag));
    }

    private static byte[] DecryptPart(
        EncryptedPart part,
        ReadOnlySpan<byte> key,
        ReadOnlySpan<byte> associatedData)
    {
        byte[] nonce;
        byte[] ciphertext;
        byte[] tag;
        try
        {
            nonce = Convert.FromBase64String(part.Iv);
            ciphertext = Convert.FromBase64String(part.Ciphertext);
            tag = Convert.FromBase64String(part.Tag);
        }
        catch (FormatException error)
        {
            throw new CryptographicException("The encrypted envelope contains invalid Base64.", error);
        }

        try
        {
            if (nonce.Length != NonceBytes || tag.Length != TagBytes)
            {
                throw new CryptographicException("The encrypted envelope has invalid AES-GCM fields.");
            }
            var plaintext = new byte[ciphertext.Length];
            using var aes = new AesGcm(key, TagBytes);
            aes.Decrypt(nonce, ciphertext, tag, plaintext, associatedData);
            return plaintext;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(nonce);
            CryptographicOperations.ZeroMemory(ciphertext);
            CryptographicOperations.ZeroMemory(tag);
        }
    }

    private static void ValidateEnvelope(Envelope envelope)
    {
        if (envelope.Version != 1 ||
            envelope.Algorithm != "A256GCM" ||
            envelope.KeyId <= 0 ||
            envelope.WrappedKey is null ||
            envelope.Data is null)
        {
            throw new CryptographicException("The encrypted envelope version is unsupported.");
        }
    }

    private static string WrappedKeyAad(int version, string context) =>
        $"sluice:dek:v1:kid={version}:{context}";

    private static string PayloadAad(int version, string context) =>
        $"sluice:data:v1:kid={version}:{context}";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false
    };

    private sealed record Envelope(
        [property: JsonPropertyName("v")] int Version,
        [property: JsonPropertyName("alg")] string Algorithm,
        [property: JsonPropertyName("kid")] int KeyId,
        [property: JsonPropertyName("wrappedKey")] EncryptedPart WrappedKey,
        [property: JsonPropertyName("data")] EncryptedPart Data);

    private sealed record EncryptedPart(
        [property: JsonPropertyName("iv")] string Iv,
        [property: JsonPropertyName("ciphertext")] string Ciphertext,
        [property: JsonPropertyName("tag")] string Tag);
}
