# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim@sha256:3c0edbfe1549dd93fb789dc96299a40df865ad7bffefcaf38e8c05940686d641 AS build
WORKDIR /source

COPY apps/worker/Sluice.Worker.sln apps/worker/
COPY apps/worker/src/Sluice.Worker/Sluice.Worker.csproj apps/worker/src/Sluice.Worker/
COPY apps/worker/tests/Sluice.Worker.Tests/Sluice.Worker.Tests.csproj apps/worker/tests/Sluice.Worker.Tests/
RUN dotnet restore apps/worker/Sluice.Worker.sln

COPY apps/worker/ apps/worker/
RUN dotnet test apps/worker/Sluice.Worker.sln \
      --configuration Release \
      --no-restore \
  && dotnet publish apps/worker/src/Sluice.Worker/Sluice.Worker.csproj \
      --configuration Release \
      --no-restore \
      --output /app \
      /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:9.0-bookworm-slim@sha256:86085bc68dde4a8cdfd8c2342acc3bf843eade855092879a85e3f3adb56e55c7 AS runtime
WORKDIR /app
ENV DOTNET_EnableDiagnostics=0 \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    WORKER_DIAGNOSTICS_URL=http://0.0.0.0:8080
EXPOSE 8080
COPY --from=build --chown=$APP_UID:$APP_UID /app ./
USER $APP_UID
ENTRYPOINT ["dotnet", "Sluice.Worker.dll"]
