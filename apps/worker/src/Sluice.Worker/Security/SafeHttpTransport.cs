using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Globalization;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;

namespace Sluice.Worker.Security;

public sealed class SafeHttpTransport : IDisposable
{
    private readonly SsrfGuard _guard;
    private readonly SocketsHttpHandler _handler;
    private readonly HttpClient _client;

    public SafeHttpTransport(SsrfGuard guard)
    {
        _guard = guard;
        _handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(5),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
            MaxConnectionsPerServer = 100,
            UseCookies = false,
            UseProxy = false,
            SslOptions = new SslClientAuthenticationOptions
            {
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                CertificateRevocationCheckMode = X509RevocationMode.Online
            },
            ConnectCallback = ConnectPublicAsync
        };
        _client = new HttpClient(_handler, disposeHandler: false)
        {
            Timeout = Timeout.InfiniteTimeSpan,
            MaxResponseContentBufferSize = 2 * 1024 * 1024
        };
        _client.DefaultRequestHeaders.UserAgent.ParseAdd("Sluice-Worker/1.0");
    }

    public async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        IReadOnlySet<string> allowedHosts,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        if (request.RequestUri is null)
        {
            throw new HttpRequestException("The outbound request has no destination.");
        }
        await _guard.ValidateAndResolveAsync(
            request.RequestUri,
            allowedHosts,
            cancellationToken);

        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        try
        {
            return await _client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                timeoutSource.Token);
        }
        catch (OperationCanceledException error) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("The outbound request exceeded its deadline.", error);
        }
    }

    public void Dispose()
    {
        _client.Dispose();
        _handler.Dispose();
    }

    private async ValueTask<Stream> ConnectPublicAsync(
        SocketsHttpConnectionContext context,
        CancellationToken cancellationToken)
    {
        var hostSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            new IdnMapping().GetAscii(context.DnsEndPoint.Host)
        };
        var probe = new UriBuilder(
            Uri.UriSchemeHttps,
            context.DnsEndPoint.Host,
            context.DnsEndPoint.Port).Uri;
        var addresses = await _guard.ValidateAndResolveAsync(probe, hostSet, cancellationToken);

        Exception? lastError = null;
        foreach (var address in addresses)
        {
            var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp)
            {
                NoDelay = true
            };
            try
            {
                await socket.ConnectAsync(
                    new IPEndPoint(address, context.DnsEndPoint.Port),
                    cancellationToken);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch (Exception error) when (error is SocketException or OperationCanceledException)
            {
                lastError = error;
                socket.Dispose();
                if (error is OperationCanceledException)
                {
                    throw;
                }
            }
        }

        throw new HttpRequestException("No public address accepted the outbound connection.", lastError);
    }
}
