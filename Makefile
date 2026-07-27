SHELL := /bin/sh
COMPOSE := docker compose --env-file .env
APP_COMPOSE := $(COMPOSE) -f docker-compose.yml -f infra/compose.apps.yml
DEV_COMPOSE := $(APP_COMPOSE) -f infra/compose.dev.yml
TLS_COMPOSE := $(APP_COMPOSE) -f infra/compose.tls.yml

.PHONY: help doctor config build up up-core down logs migrate test-db test-api test-worker test-dashboard test validate reset

help:
	@echo "Sluice development commands"
	@echo "  make doctor    Check required tools"
	@echo "  make config    Validate the production-safe Compose file"
	@echo "  make build     Build local images"
	@echo "  make up        Start with local-only host ports"
	@echo "  make up-core   Start the production-safe core (no DB/Redis host ports)"
	@echo "  make migrate   Reapply idempotent SQL migrations"
	@echo "  make test-db   Run database contract tests"
	@echo "  make test-api  Run ingest API checks"
	@echo "  make test-worker Run C# worker checks"
	@echo "  make test-dashboard Run dashboard checks"
	@echo "  make test      Run all available checks"
	@echo "  make down      Stop containers without deleting data"

doctor:
	@git --version
	@docker --version
	@docker compose version
	@node --version
	@npm --version
	@dotnet --version
	@openssl version
	@test -f .env || (echo "Missing .env; copy .env.example first" && exit 1)

config:
	@$(COMPOSE) -f docker-compose.yml config --quiet
	@$(APP_COMPOSE) config --quiet
	@$(DEV_COMPOSE) config --quiet
	@$(TLS_COMPOSE) config --quiet

build:
	@$(DEV_COMPOSE) build

up:
	@$(DEV_COMPOSE) up --build -d
	@$(DEV_COMPOSE) ps

up-core:
	@$(COMPOSE) -f docker-compose.yml up --build -d
	@$(COMPOSE) -f docker-compose.yml ps

down:
	@$(DEV_COMPOSE) down

logs:
	@$(DEV_COMPOSE) logs --follow --tail=200

migrate:
	@$(DEV_COMPOSE) exec -T postgres \
		/docker-entrypoint-initdb.d/00-bootstrap.sh

test-db:
	@$(DEV_COMPOSE) exec -T postgres sh -ec \
		'PGPASSWORD="$${POSTGRES_PASSWORD}" exec psql --no-psqlrc \
		-v ON_ERROR_STOP=1 -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"' \
		< database/tests/contracts.sql

test-api:
	@npm --prefix apps/ingest-api run typecheck
	@npm --prefix apps/ingest-api run lint
	@npm --prefix apps/ingest-api test
	@npm --prefix apps/ingest-api run build

test-worker:
	@dotnet restore apps/worker/Sluice.Worker.sln
	@dotnet format apps/worker/Sluice.Worker.sln --verify-no-changes --no-restore
	@dotnet build apps/worker/Sluice.Worker.sln -c Release --no-restore
	@dotnet test apps/worker/Sluice.Worker.sln -c Release --no-build

test-dashboard:
	@npm --prefix apps/dashboard run typecheck
	@npm --prefix apps/dashboard run lint
	@npm --prefix apps/dashboard test

test: config test-db test-api test-worker test-dashboard

validate: test

reset:
	@if [ "$(CONFIRM)" != "destroy-local-data" ]; then \
		echo "Refusing to delete volumes. Re-run with CONFIRM=destroy-local-data"; \
		exit 1; \
	fi
	@$(DEV_COMPOSE) down --volumes
