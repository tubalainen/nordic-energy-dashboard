# CLAUDE.md — Nordic Energy Dashboard

## Project Overview

Security-hardened Flask web application that visualizes Nordic power grid energy data (production/consumption) from Statnett.no's public API and Nordpool spot prices. Deployed via Docker behind Nginx + Cloudflare.

**Current version:** `1.8` (defined in `app/main.py` as `__version__`)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.11, Flask 3.0 |
| WSGI | Gunicorn (2 workers, gthread) |
| Database | SQLite (via `/data/energy.db`) |
| Scheduler | APScheduler (background data fetch, default 5 min) |
| Rate limiting | Flask-Limiter |
| Container | Docker (non-root, read-only rootfs) |
| Reverse proxy | Nginx + Cloudflare |

## Key Files

```
app/main.py          # Entire application — Flask routes, DB, scheduler, API calls
requirements.txt     # Python dependencies (pinned versions)
Dockerfile           # Hardened image (python:3.11-slim-bookworm, appuser)
docker-compose.yml   # Docker Compose config (port 5050:5000)
.github/workflows/
  claude.yml               # Claude Code GitHub Action (@claude trigger)
  claude-code-review.yml   # Automated PR review
  docker-publish.yml       # Build & push to ghcr.io on main branch push
```

## Architecture

```
Internet → Cloudflare → Nginx (SSL, WAF, rate limit) → Docker :5050 → Flask/Gunicorn :5000
LAN ──────────────────────────────────────────────────────────┘
```

## Data Sources

- **Energy production/consumption:** `https://driftsdata.statnett.no/restapi/ProductionConsumption/GetLatestDetailedOverview`
- **Nordpool spot prices:** Fetched directly from Nordpool dataportal REST API (no third-party library)

## Supported Countries & Zones

| Country | Zones |
|---------|-------|
| SE | SE1, SE2, SE3 (default), SE4 |
| NO | NO1 (default), NO2, NO3, NO4, NO5 |
| FI | FI |
| DK | DK1 (default), DK2 |

## Development Conventions

- **All application code lives in `app/main.py`** — single-file app, no package structure.
- **No external Nordpool library** — prices are fetched directly via REST API.
- **Security is a first-class concern** — never expose stack traces, always validate inputs against whitelists, use parameterized queries.
- **Input validation:** Country codes must be in `VALID_COUNTRY_CODES` (SE, NO, FI, DK). Days capped at `MAX_DAYS = 200`. Zones validated against `VALID_ZONES`.
- **Internal endpoints** (`/internal/*`) require `X-Internal-Request: true` header — these must remain blocked at the Nginx level from the internet.
- **Version bump:** Update `__version__` in `app/main.py` and add an entry to `CHANGELOG.md` when releasing.

## Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `DATABASE_PATH` | `/data/energy.db` | SQLite DB location |
| `FETCH_INTERVAL` | `5` | Minutes between data fetches |
| `DATA_RETENTION_DAYS` | `200` | Max days of history kept |
| `LOG_LEVEL` | `WARNING` | Set to `INFO` for debugging |
| `ENABLE_DEBUG_ENDPOINTS` | `false` | Never enable in production |
| `RATE_LIMIT_DEFAULT` | `100 per minute` | Flask-Limiter default |
| `RATE_LIMIT_API` | `30 per minute` | Flask-Limiter API routes |

## Running Locally

```bash
# Start with Docker Compose (recommended)
docker-compose up -d
docker-compose logs -f

# Health check
curl http://127.0.0.1:5050/health

# Internal endpoints (local only)
curl -H "X-Internal-Request: true" http://127.0.0.1:5050/internal/health
```

## Testing Changes

There are no automated tests in this project. When making changes to `app/main.py`:

1. Build and run locally: `docker-compose up --build`
2. Check the health endpoint: `curl http://127.0.0.1:5050/health`
3. Check the API: `curl http://127.0.0.1:5050/api/stats`
4. Review `docker-compose logs` for errors

## Security Rules

- Never expose raw exceptions or stack traces to the client.
- All DB queries must use parameterized statements (no f-strings into SQL).
- Country/zone/energy-type inputs must be validated against the frozen sets at the top of `main.py`.
- The `ENABLE_DEBUG_ENDPOINTS` flag must default to `false` and never be enabled in production.
- Container runs as `appuser` (non-root); root filesystem is read-only except `/tmp` and `/data`.

## CI/CD

- **docker-publish.yml** — builds and pushes `ghcr.io/tubalainen/nordic-energy-dashboard:main` (and version tags) on push to `main`.
- **claude-code-review.yml** — Claude automatically reviews PRs.
- **claude.yml** — Claude responds to `@claude` mentions in issues/PRs.

## Common Tasks

**Add a new API endpoint:**
- Add the route in `app/main.py`, follow existing validation/rate-limit patterns.
- Internal admin routes go under `/internal/` and require the internal header check.

**Update Python dependencies:**
- Edit `requirements.txt` with pinned versions.
- Test locally before pushing (rebuild Docker image).

**Database schema changes:**
- The app uses schema versioning (`db_version` table). Add a migration step in `init_db()` following the existing pattern.

**Release a new version:**
1. Update `__version__` in `app/main.py`.
2. Add entry to `CHANGELOG.md`.
3. Merge PR to `main` — CI builds and pushes the new image automatically.
