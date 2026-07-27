using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Npgsql;
using Sluice.Worker.Configuration;
using Sluice.Worker.Data;
using Sluice.Worker.Diagnostics;
using Sluice.Worker.Infrastructure;
using Sluice.Worker.Processing;
using Sluice.Worker.Security;

var options = WorkerOptions.FromEnvironment();
var builder = WebApplication.CreateSlimBuilder(args);
builder.WebHost.UseUrls(options.DiagnosticsUrl);
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(settings =>
{
    settings.IncludeScopes = true;
    settings.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ";
    settings.UseUtcTimestamp = true;
});

builder.Services.AddSingleton(options);
builder.Services.Configure<HostOptions>(host =>
{
    host.ShutdownTimeout = TimeSpan.FromSeconds(options.DrainSeconds + 5);
});
builder.Services.AddSingleton(static services =>
{
    var configured = services.GetRequiredService<WorkerOptions>();
    var connection = new NpgsqlConnectionStringBuilder(configured.DatabaseConnectionString)
    {
        ApplicationName = "sluice-worker",
        Timeout = 5,
        CommandTimeout = 15,
        KeepAlive = 30,
        MaxPoolSize = configured.Concurrency + 20,
        MinPoolSize = 1,
        NoResetOnClose = false
    };
    return NpgsqlDataSource.Create(connection.ConnectionString);
});
builder.Services.AddSingleton<WorkerRepository>();
builder.Services.AddSingleton<EnvelopeCrypto>();
builder.Services.AddSingleton<SsrfGuard>();
builder.Services.AddSingleton<SafeHttpTransport>();
builder.Services.AddSingleton<WorkerMetrics>();
builder.Services.AddSingleton<WakeSignal>();
builder.Services.AddSingleton<PostgresWakeSubscriber>();
builder.Services.AddSingleton<RedisWakeSubscriber>();
builder.Services.AddSingleton<IJobHandler, WebhookDeliveryHandler>();
builder.Services.AddSingleton<IJobHandler, ReconciliationHandler>();
builder.Services.AddSingleton<JobDispatcher>();

builder.Services.AddHostedService<DatabaseContractValidationService>();
builder.Services.AddHostedService(static services =>
    services.GetRequiredService<PostgresWakeSubscriber>());
builder.Services.AddHostedService(static services =>
    services.GetRequiredService<RedisWakeSubscriber>());
builder.Services.AddHostedService<JobPumpService>();
builder.Services.AddHostedService<NotificationPumpService>();

var app = builder.Build();
app.MapGet("/health/live", static () => Results.Ok(new { status = "ok" }));
app.MapGet(
    "/health/ready",
    async Task<IResult> (
        WorkerRepository repository,
        PostgresWakeSubscriber postgresNotifications,
        RedisWakeSubscriber redis,
        CancellationToken cancellationToken) =>
    {
        var databaseReady = await repository.IsReadyAsync(cancellationToken);
        var postgresNotifyState = postgresNotifications.Connected
            ? "ok"
            : "degraded_polling";
        var redisState = redis.Configured
            ? redis.Connected ? "ok" : "degraded_polling"
            : "disabled_polling";
        if (!databaseReady)
        {
            return Results.Json(
                new
                {
                    status = "not_ready",
                    checks = new
                    {
                        postgres = "failed",
                        postgres_notify = postgresNotifyState,
                        redis_wakeup = redisState
                    }
                },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
        var degraded =
            !postgresNotifications.Connected ||
            (redis.Configured && !redis.Connected);
        return Results.Ok(
            new
            {
                status = degraded ? "degraded" : "ok",
                checks = new
                {
                    postgres = "ok",
                    postgres_notify = postgresNotifyState,
                    redis_wakeup = redisState
                }
            });
    });
app.MapGet(
    "/metrics",
    (HttpRequest request, WorkerMetrics metrics) =>
    {
        if (options.MetricsBearerToken is not null &&
            !FixedTimeEquals(
                request.Headers.Authorization.ToString(),
                $"Bearer {options.MetricsBearerToken}"))
        {
            return Results.Unauthorized();
        }
        return Results.Text(
            metrics.RenderPrometheus(),
            "text/plain; version=0.0.4; charset=utf-8");
    });

await app.RunAsync();

static bool FixedTimeEquals(string left, string right)
{
    var leftBytes = Encoding.UTF8.GetBytes(left);
    var rightBytes = Encoding.UTF8.GetBytes(right);
    var maximum = Math.Max(leftBytes.Length, rightBytes.Length);
    var leftPadded = new byte[Math.Max(1, maximum)];
    var rightPadded = new byte[Math.Max(1, maximum)];
    leftBytes.CopyTo(leftPadded, 0);
    rightBytes.CopyTo(rightPadded, 0);
    try
    {
        return CryptographicOperations.FixedTimeEquals(leftPadded, rightPadded) &&
               leftBytes.Length == rightBytes.Length;
    }
    finally
    {
        CryptographicOperations.ZeroMemory(leftBytes);
        CryptographicOperations.ZeroMemory(rightBytes);
        CryptographicOperations.ZeroMemory(leftPadded);
        CryptographicOperations.ZeroMemory(rightPadded);
    }
}
