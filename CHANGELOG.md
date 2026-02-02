# Changelog

All notable changes to the Nordic Energy Dashboard project will be documented in this file.

## [1.5] - 2026-02-02

This is the first official release of the Nordic Energy Dashboard - a security-hardened Flask application for visualizing Nordic power grid energy data.

### Features

- **Nordic Energy Production/Consumption Dashboard** - Real-time visualization of energy data from Statnett.no's public API for SE, NO, FI, and DK regions
- **Nordpool Spot Prices** - Current spot price display with support for EUR, SEK, DKK, and NOK currencies, shown in kWh
- **Today/Tomorrow Price Graphs** - Visual price trend charts for current and next-day energy prices
- **Nordpool-Wind Correlation Analysis** - Correlation analysis between wind production and spot prices
- **Currency Selection** - User-selectable currency display (EUR/SEK/DKK/NOK)
- **Database Schema Versioning** - Automatic database migration system with version tracking
- **Direct API Integration** - Nordpool prices fetched directly via REST API (replaced external library dependency)
- **UI Fallback Messages** - Graceful handling of API failures with user-friendly fallback messages in UI boxes

### Security

- Non-root container execution with dedicated `appuser`
- Read-only root filesystem (writable: /tmp, /data only)
- All Linux capabilities dropped
- Content Security Policy (CSP) headers
- X-Frame-Options, X-Content-Type-Options headers
- Path filtering (blocks .php, .env, wp-admin, etc.)
- SQL injection prevention via parameterized queries
- Rate limiting via Flask-Limiter (30 requests/minute for API)
- Input validation with country whitelist
- No stack traces exposed in production

### Infrastructure

- Docker and Docker Compose deployment
- Gunicorn WSGI server with preload workers
- APScheduler for background data fetching (configurable interval)
- SQLite database with configurable data retention (200 days default)
- Health check endpoint
- Log rotation (10MB max, 3 files)
- GitHub Actions CI/CD with Claude Code integration for PR reviews
