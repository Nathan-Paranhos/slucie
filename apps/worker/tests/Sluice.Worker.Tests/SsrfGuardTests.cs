using System.Net;
using Sluice.Worker.Security;

namespace Sluice.Worker.Tests;

public sealed class SsrfGuardTests
{
    public static TheoryData<string> ProhibitedAddresses =>
        new()
        {
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::2",
            "::ffff:127.0.0.1"
        };

    [Theory]
    [MemberData(nameof(ProhibitedAddresses))]
    public void RejectsNonPublicNetworks(string rawAddress) =>
        Assert.False(SsrfGuard.IsPublicAddress(IPAddress.Parse(rawAddress)));

    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("1.1.1.1")]
    [InlineData("2606:4700:4700::1111")]
    public void AcceptsPublicNetworks(string rawAddress) =>
        Assert.True(SsrfGuard.IsPublicAddress(IPAddress.Parse(rawAddress)));

    [Fact]
    public void RequiresHttpsAndExactAllowlistMatch()
    {
        var hosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "example.com" };

        SsrfGuard.ValidateUri(new Uri("https://example.com/hooks"), hosts);
        Assert.Throws<HttpRequestException>(
            () => SsrfGuard.ValidateUri(new Uri("http://example.com/hooks"), hosts));
        Assert.Throws<HttpRequestException>(
            () => SsrfGuard.ValidateUri(new Uri("https://sub.example.com/hooks"), hosts));
        Assert.Throws<HttpRequestException>(
            () => SsrfGuard.ValidateUri(new Uri("https://user@example.com/hooks"), hosts));
    }
}
