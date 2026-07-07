COMPOSE := docker compose

.PHONY: up down migrate revision test logs

up: ## build + start the full stack (creates .env from the example on first run)
	@test -f .env || cp .env.example .env
	$(COMPOSE) up -d --build

down: ## stop everything (named volumes survive; db-test is tmpfs anyway)
	$(COMPOSE) down

migrate: ## apply migrations on the containerized dev Postgres
	$(COMPOSE) exec api alembic upgrade head

revision: ## autogenerate a migration: make revision m="add replays table"
	$(COMPOSE) exec api alembic revision --autogenerate -m "$(m)"

test: ## run the suite against the throwaway db-test
	@test -f .env || cp .env.example .env
	$(COMPOSE) up -d db-test
	$(COMPOSE) run --build --rm --no-deps api pytest

logs:
	$(COMPOSE) logs -f api
