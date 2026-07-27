using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace Sluice.Worker.Security;

public sealed class SsrfGuard
{
    public async Task<IReadOnlyList<IPAddress>> ValidateAndResolveAsync(
        Uri uri,
        IReadOnlySet<string> allowedHosts,
        CancellationToken cancellationToken)
    {
        ValidateUri(uri, allowedHosts);
        IPAddress[] addresses;
        try
        {
            addresses = await Dns.GetHostAddressesAsync(uri.DnsSafeHost, cancellationToken);
        }
        catch (SocketException error)
        {
            throw new HttpRequestException("The destination hostname could not be resolved.", error);
        }

        if (addresses.Length == 0 || addresses.Any(static address => !IsPublicAddress(address)))
        {
            throw new HttpRequestException("The destination resolves to a prohibited network.");
        }
        return addresses;
    }

    public static void ValidateUri(Uri uri, IReadOnlySet<string> allowedHosts)
    {
        if (!uri.IsAbsoluteUri ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            string.IsNullOrEmpty(uri.Host) ||
            uri.IsFile)
        {
            throw new HttpRequestException("Only absolute HTTPS destinations without userinfo are allowed.");
        }

        var normalizedHost = new IdnMapping().GetAscii(uri.IdnHost).ToLowerInvariant();
        if (!allowedHosts.Contains(normalizedHost))
        {
            throw new HttpRequestException("The destination host is not allowlisted.");
        }

        if (IPAddress.TryParse(uri.Host, out var literal) && !IsPublicAddress(literal))
        {
            throw new HttpRequestException("The destination IP address is prohibited.");
        }
    }

    public static bool IsPublicAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var bytes = address.GetAddressBytes();
            var first = bytes[0];
            var second = bytes[1];

            return first != 0 &&
                   first != 10 &&
                   first != 127 &&
                   !(first == 100 && second is >= 64 and <= 127) &&
                   !(first == 169 && second == 254) &&
                   !(first == 172 && second is >= 16 and <= 31) &&
                   !(first == 192 && second == 0) &&
                   !(first == 192 && second == 168) &&
                   !(first == 192 && second == 88 && bytes[2] == 99) &&
                   !(first == 192 && second == 0 && bytes[2] == 2) &&
                   !(first == 198 && second is 18 or 19) &&
                   !(first == 198 && second == 51 && bytes[2] == 100) &&
                   !(first == 203 && second == 0 && bytes[2] == 113) &&
                   first < 224;
        }

        if (address.AddressFamily != AddressFamily.InterNetworkV6 ||
            IPAddress.IPv6Any.Equals(address) ||
            IPAddress.IPv6None.Equals(address) ||
            IPAddress.IPv6Loopback.Equals(address) ||
            address.IsIPv6LinkLocal ||
            address.IsIPv6Multicast ||
            address.IsIPv6SiteLocal)
        {
            return false;
        }

        var ipv6 = address.GetAddressBytes();
        var globalUnicast = (ipv6[0] & 0xE0) == 0x20;
        var uniqueLocal = (ipv6[0] & 0xFE) == 0xFC;
        var documentation = ipv6[0] == 0x20 &&
                            ipv6[1] == 0x01 &&
                            ipv6[2] == 0x0D &&
                            ipv6[3] == 0xB8;
        var teredo = ipv6[0] == 0x20 &&
                     ipv6[1] == 0x01 &&
                     ipv6[2] == 0x00 &&
                     ipv6[3] == 0x00;
        if (!globalUnicast || uniqueLocal || documentation || teredo)
        {
            return false;
        }

        if (ipv6[0] == 0x20 && ipv6[1] == 0x02)
        {
            return IsPublicAddress(new IPAddress(ipv6.AsSpan(2, 4)));
        }
        return true;
    }
}
