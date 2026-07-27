using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Sluice.Worker.Configuration;
using Sluice.Worker.Data;
using Sluice.Worker.Diagnostics;
using Sluice.Worker.Infrastructure;
using Sluice.Worker.Models;
using Sluice.Worker.Security;

namespace Sluice.Worker.Processing;

public sealed class NotificationPumpService(
    WorkerOptions options,
    WorkerRepository repository,
    SafeHttpTransport transport,
    WakeSignal wakeSignal,
    WorkerMetrics metrics,
    ILogger<NotificationPumpService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            IReadOnlyList<ClaimedNotification> notifications;
            try
            {
                notifications = await repository.ClaimNotificationsAsync(
                    options.WorkerId,
                    Math.Min(20, options.Concurrency),
                    Math.Clamp(
                        (options.NotificationTimeoutMilliseconds / 1_000) + 30,
                        60,
                        3_600),
                    CancellationToken.None);
            }
            catch (Exception error)
            {
                logger.LogWarning(
                    "Notification claim failed; polling continues (exception_type={ExceptionType})",
                    error.GetType().Name);
                await DelaySafelyAsync(TimeSpan.FromSeconds(2), stoppingToken);
                continue;
            }

            if (notifications.Count == 0)
            {
                await wakeSignal.WaitForNotificationsAsync(
                    TimeSpan.FromMilliseconds(options.PollIntervalMilliseconds),
                    stoppingToken);
                continue;
            }

            await Task.WhenAll(notifications.Select(ProcessAndDisposeAsync));
        }
    }

    private async Task ProcessAndDisposeAsync(ClaimedNotification notification)
    {
        using (notification)
        {
            await ProcessAsync(notification);
        }
    }

    private async Task ProcessAsync(ClaimedNotification notification)
    {
        try
        {
            switch (notification.Channel)
            {
                case "dashboard":
                    break;
                case "webhook":
                    await SendAsync(
                        notification,
                        options.NotificationWebhookEndpoint
                        ?? throw new InvalidOperationException(
                            "The fixed notification webhook endpoint is not configured."));
                    break;
                case "email":
                    await SendAsync(
                        notification,
                        options.NotificationEmailEndpoint
                        ?? throw new InvalidOperationException(
                            "The fixed email delivery endpoint is not configured."));
                    break;
                default:
                    throw new InvalidOperationException("The notification channel is unsupported.");
            }

            if (await repository.CompleteNotificationAsync(
                notification,
                CancellationToken.None))
            {
                metrics.Notification();
            }
            else
            {
                logger.LogWarning(
                    "Notification completion rejected by lease fence (notification_id={NotificationId})",
                    notification.NotificationId);
            }
        }
        catch (Exception error)
        {
            var safeError = error switch
            {
                TimeoutException => "notification_timeout",
                HttpRequestException => "notification_transport_failed",
                InvalidOperationException => "notification_configuration_invalid",
                _ => "notification_delivery_failed"
            };
            var state = await repository.FailNotificationAsync(
                notification,
                safeError,
                CancellationToken.None);
            logger.LogWarning(
                "Notification failed (notification_id={NotificationId}, code={Code}, state={State}, exception_type={ExceptionType})",
                notification.NotificationId,
                safeError,
                state,
                error.GetType().Name);
        }
    }

    private async Task SendAsync(ClaimedNotification notification, Uri endpoint)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(notification.Payload.RootElement);
        try
        {
            if (payload.Length > 1024 * 1024)
            {
                throw new InvalidOperationException("The notification payload is too large.");
            }
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
            {
                Content = new ByteArrayContent(payload)
            };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            request.Headers.TryAddWithoutValidation(
                "Idempotency-Key",
                $"notification:{notification.TenantId:D}:{notification.NotificationId:D}");
            using var response = await transport.SendAsync(
                request,
                options.NotificationAllowedHosts,
                TimeSpan.FromMilliseconds(options.NotificationTimeoutMilliseconds),
                CancellationToken.None);
            var code = (int)response.StatusCode;
            if (!response.IsSuccessStatusCode)
            {
                throw code is 408 or 425 or 429 || code >= 500
                    ? new HttpRequestException("The notification endpoint returned a retryable status.")
                    : new InvalidOperationException("The notification endpoint rejected the request.");
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
        }
    }

    private static async Task DelaySafelyAsync(
        TimeSpan delay,
        CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(delay, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }
}
