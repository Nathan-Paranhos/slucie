using System.Security.Cryptography;
using System.Text;
using Sluice.Worker.Security;

namespace Sluice.Worker.Tests;

public sealed class EnvelopeCryptoTests
{
    [Fact]
    public void DecryptsEnvelopeProducedByNodeImplementation()
    {
        var key = Convert.FromBase64String(
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
        var crypto = new EnvelopeCrypto(TestOptions.Create(key));
        const string context =
            "webhook-event-body:11111111-1111-1111-1111-111111111111:" +
            "22222222-2222-2222-2222-222222222222:" +
            "abababababababababababababababababababababababababababababababab";
        const string envelope =
            """
            {"v":1,"alg":"A256GCM","kid":1,"wrappedKey":{"iv":"AAECAwQFBgcICQoL","ciphertext":"ZyP0OOHA5DylaL2gncRWQrPntQfETmlLAF7fviFUPo0=","tag":"MUJMi7sY3Joz0daHGuiLLw=="},"data":{"iv":"DA0ODxAREhMUFRYX","ciphertext":"mRghXhYHdM2rMJk=","tag":"jQdQP68cGpiwDrD3x6HqHQ=="}}
            """;

        var plaintext = crypto.Decrypt(Encoding.UTF8.GetBytes(envelope), context, 1);

        Assert.Equal("{\"ok\":true}", Encoding.UTF8.GetString(plaintext));
        CryptographicOperations.ZeroMemory(plaintext);
        CryptographicOperations.ZeroMemory(key);
    }

    [Fact]
    public void RoundTripsAndAuthenticatesContextAndKeyVersion()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var crypto = new EnvelopeCrypto(TestOptions.Create(key, 7));
        var plaintext = Encoding.UTF8.GetBytes("confidential");
        var envelope = crypto.Encrypt(plaintext, "tenant:context");

        var decrypted = crypto.Decrypt(envelope, "tenant:context", 7);

        Assert.Equal(plaintext, decrypted);
        Assert.ThrowsAny<CryptographicException>(
            () => crypto.Decrypt(envelope, "other-context", 7));
        Assert.Throws<CryptographicException>(
            () => crypto.Decrypt(envelope, "tenant:context", 6));
        CryptographicOperations.ZeroMemory(decrypted);
        CryptographicOperations.ZeroMemory(envelope);
        CryptographicOperations.ZeroMemory(plaintext);
        CryptographicOperations.ZeroMemory(key);
    }

    [Fact]
    public void RejectsTampering()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var crypto = new EnvelopeCrypto(TestOptions.Create(key));
        var envelope = crypto.Encrypt("payload"u8, "context");
        var marker = Encoding.UTF8.GetBytes("\"tag\":\"");
        var markerOffset = envelope.AsSpan().IndexOf(marker);
        Assert.True(markerOffset >= 0);
        envelope[markerOffset + marker.Length] =
            envelope[markerOffset + marker.Length] == (byte)'A' ? (byte)'B' : (byte)'A';

        Assert.ThrowsAny<CryptographicException>(
            () => crypto.Decrypt(envelope, "context"));

        CryptographicOperations.ZeroMemory(envelope);
        CryptographicOperations.ZeroMemory(key);
    }
}
