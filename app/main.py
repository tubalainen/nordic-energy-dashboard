#!/usr/bin/env python3
"""
Nordic Energy Dashboard - Main Application (Hardened)
Security-hardened version for production deployment
Includes Nordpool spot price correlation analysis
"""

import os
import sys
import sqlite3
import logging
import re
import math
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, render_template, jsonify, request, abort
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from apscheduler.schedulers.background import BackgroundScheduler
import requests
from contextlib import contextmanager

# =============================================================================
# CONFIGURATION
# =============================================================================

DATABASE_PATH = os.environ.get('DATABASE_PATH', '/data/energy.db')
FETCH_INTERVAL_MINUTES = int(os.environ.get('FETCH_INTERVAL', 5))
DATA_RETENTION_DAYS = int(os.environ.get('DATA_RETENTION_DAYS', 200))
LOG_LEVEL = os.environ.get('LOG_LEVEL', 'WARNING').upper()

# Security settings
ENABLE_DEBUG_ENDPOINTS = os.environ.get('ENABLE_DEBUG_ENDPOINTS', 'false').lower() == 'true'
RATE_LIMIT_DEFAULT = os.environ.get('RATE_LIMIT_DEFAULT', '100 per minute')
RATE_LIMIT_API = os.environ.get('RATE_LIMIT_API', '30 per minute')

# API URLs
URL_CONSUMPTION = "https://driftsdata.statnett.no/restapi/ProductionConsumption/GetLatestDetailedOverview"

# Strict whitelist of allowed countries
COUNTRIES = {
    "SE": "Sweden",
    "NO": "Norway",
    "FI": "Finland",
    "DK": "Denmark"
}

VALID_COUNTRY_CODES = frozenset(COUNTRIES.keys())
MAX_DAYS = 200

# Nordpool bidding zones per country
COUNTRY_ZONES = {
    'SE': ['SE1', 'SE2', 'SE3', 'SE4'],
    'NO': ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'],
    'FI': ['FI'],
    'DK': ['DK1', 'DK2']
}

DEFAULT_ZONE = {
    'SE': 'SE3',
    'NO': 'NO1',
    'FI': 'FI',
    'DK': 'DK1'
}

ZONE_TO_COUNTRY = {}
for _country, _zones in COUNTRY_ZONES.items():
    for _z in _zones:
        ZONE_TO_COUNTRY[_z] = _country

VALID_ZONES = frozenset(ZONE_TO_COUNTRY.keys())
VALID_ENERGY_TYPES = frozenset(['nuclear', 'hydro', 'wind', 'thermal', 'not_specified'])

# =============================================================================
# LOGGING SETUP
# =============================================================================

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.WARNING),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger('energy-dashboard')

logging.getLogger('apscheduler').setLevel(logging.WARNING)
logging.getLogger('werkzeug').setLevel(logging.WARNING)

# =============================================================================
# FLASK APP SETUP
# =============================================================================

app = Flask(__name__,
            template_folder='/app/templates',
            static_folder='/app/static')

app.config['MAX_CONTENT_LENGTH'] = 1 * 1024 * 1024  # 1MB max
app.config['JSON_SORT_KEYS'] = False

def get_real_ip():
    """Get real client IP, considering reverse proxy headers"""
    if request.headers.get('CF-Connecting-IP'):
        return request.headers.get('CF-Connecting-IP')
    if request.headers.get('X-Real-IP'):
        return request.headers.get('X-Real-IP')
    if request.headers.get('X-Forwarded-For'):
        return request.headers.get('X-Forwarded-For').split(',')[0].strip()
    return request.remote_addr or '127.0.0.1'

limiter = Limiter(
    key_func=get_real_ip,
    app=app,
    default_limits=[RATE_LIMIT_DEFAULT],
    storage_uri="memory://",
    strategy="fixed-window"
)

scheduler = None
last_fetch_time = None
last_fetch_status = None
last_price_fetch_time = None
last_price_fetch_status = None
last_exchange_rate_fetch_time = None
last_exchange_rate_fetch_status = None

# Exchange rates (EUR base)
exchange_rates = {
    'EUR': 1.0,
    'SEK': 11.0,   # Fallback defaults
    'DKK': 7.45,
    'NOK': 11.5
}
VALID_CURRENCIES = frozenset(['EUR', 'SEK', 'DKK', 'NOK'])

# =============================================================================
# SECURITY MIDDLEWARE
# =============================================================================

@app.before_request
def security_checks():
    """Perform security checks before each request"""
    if request.path:
        # Block path traversal
        if '..' in request.path or '//' in request.path:
            logger.warning(f"Blocked path traversal: {request.path} from {get_real_ip()}")
            abort(400)

        # Block common exploit paths
        blocked_patterns = [
            r'\.php$', r'\.asp$', r'\.jsp$', r'\.cgi$',
            r'wp-admin', r'wp-content', r'phpMyAdmin',
            r'\.env', r'\.git', r'\.htaccess', r'actuator'
        ]
        for pattern in blocked_patterns:
            if re.search(pattern, request.path, re.IGNORECASE):
                logger.warning(f"Blocked suspicious path: {request.path} from {get_real_ip()}")
                abort(404)


@app.after_request
def add_security_headers(response):
    """Add security headers to all responses"""
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=()'

    csp = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: https://flagcdn.com; "
        "connect-src 'self'; "
        "frame-ancestors 'self'; "
        "base-uri 'self'; "
        "form-action 'self';"
    )
    response.headers['Content-Security-Policy'] = csp
    response.headers.pop('Server', None)

    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'

    return response


def internal_only(f):
    """Decorator to restrict endpoint to internal/nginx access only"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Check for internal request header (set by nginx)
        if request.headers.get('X-Internal-Request') != 'true':
            logger.warning(f"Blocked external access to {request.path} from {get_real_ip()}")
            abort(403)
        return f(*args, **kwargs)
    return decorated_function


# =============================================================================
# INPUT VALIDATION
# =============================================================================

def validate_country_code(country):
    """Validate and sanitize country code"""
    if not country:
        return None
    country = country.upper().strip()
    if country not in VALID_COUNTRY_CODES:
        return None
    return country


def validate_days(days_str, default=7, max_days=MAX_DAYS):
    """Validate and sanitize days parameter"""
    try:
        days = int(days_str)
        return max(1, min(days, max_days))
    except (TypeError, ValueError):
        return default


def validate_zone(zone_str, country=None):
    """Validate and sanitize zone code"""
    if not zone_str:
        if country and country in DEFAULT_ZONE:
            return DEFAULT_ZONE[country]
        return None
    zone = zone_str.upper().strip()
    if zone not in VALID_ZONES:
        return None
    return zone


def validate_energy_type(energy_type_str):
    """Validate energy type parameter"""
    if not energy_type_str:
        return None
    et = energy_type_str.lower().strip()
    if et not in VALID_ENERGY_TYPES:
        return None
    return et


# =============================================================================
# STATISTICS HELPERS
# =============================================================================

def pearson_correlation(x, y):
    """Calculate Pearson correlation coefficient between two lists"""
    n = len(x)
    if n < 3:
        return None
    mean_x = sum(x) / n
    mean_y = sum(y) / n
    numerator = sum((xi - mean_x) * (yi - mean_y) for xi, yi in zip(x, y))
    denom_x = sum((xi - mean_x) ** 2 for xi in x)
    denom_y = sum((yi - mean_y) ** 2 for yi in y)
    if denom_x == 0 or denom_y == 0:
        return None
    return numerator / math.sqrt(denom_x * denom_y)


def interpret_correlation(r):
    """Return a human-readable interpretation of a correlation coefficient"""
    if r is None:
        return 'insufficient data'
    abs_r = abs(r)
    direction = 'negative' if r < 0 else 'positive'
    if abs_r >= 0.7:
        strength = 'strong'
    elif abs_r >= 0.4:
        strength = 'moderate'
    elif abs_r >= 0.2:
        strength = 'weak'
    else:
        strength = 'negligible'
    return f"{strength} {direction}"


# =============================================================================
# DATABASE
# =============================================================================

@contextmanager
def get_db():
    """Context manager for database connections"""
    conn = sqlite3.connect(DATABASE_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('PRAGMA journal_mode = WAL')
    try:
        yield conn
    finally:
        conn.close()


SCHEMA_TARGET_VERSION = 2


def _migrate_v1(cursor):
    """Migration v1: Create baseline tables (energy_status, energy_types) and indices."""
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS energy_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME NOT NULL,
            country TEXT NOT NULL CHECK(country IN ('SE', 'NO', 'FI', 'DK')),
            production REAL,
            consumption REAL,
            import_value REAL,
            export_value REAL,
            UNIQUE(timestamp, country)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS energy_types (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME NOT NULL,
            country TEXT NOT NULL CHECK(country IN ('SE', 'NO', 'FI', 'DK')),
            nuclear REAL,
            hydro REAL,
            wind REAL,
            thermal REAL,
            not_specified REAL,
            UNIQUE(timestamp, country)
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_status_ts ON energy_status(timestamp)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_status_country ON energy_status(country)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_types_ts ON energy_types(timestamp)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_types_country ON energy_types(country)')


def _migrate_v2(cursor):
    """Migration v2: Add spot_prices table and indices."""
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS spot_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME NOT NULL,
            country TEXT NOT NULL CHECK(country IN ('SE', 'NO', 'FI', 'DK')),
            zone TEXT NOT NULL,
            price REAL NOT NULL,
            currency TEXT DEFAULT 'EUR',
            UNIQUE(timestamp, zone)
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_prices_ts ON spot_prices(timestamp)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_prices_zone ON spot_prices(zone)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_prices_country ON spot_prices(country)')


# Ordered list of migrations.  Key = target version, value = callable.
MIGRATIONS = {
    1: _migrate_v1,
    2: _migrate_v2,
}


def _get_schema_version(cursor):
    """Return the current schema version, or 0 if the database is fresh."""
    # Check if the schema_version table exists
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    )
    if cursor.fetchone() is None:
        # No version table — check if this is a pre-versioning database
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='energy_status'"
        )
        has_energy_status = cursor.fetchone() is not None

        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='spot_prices'"
        )
        has_spot_prices = cursor.fetchone() is not None

        if has_energy_status and has_spot_prices:
            # Database has all current tables but no version tracking (created
            # before versioning was added).  Treat as version 2.
            return 2
        elif has_energy_status:
            # Original schema from the first commit — version 1.
            return 1
        else:
            # Completely fresh database.
            return 0

    cursor.execute('SELECT MAX(version) as current_version FROM schema_version')
    row = cursor.fetchone()
    return row['current_version'] if row and row['current_version'] is not None else 0


def _set_schema_version(cursor, version):
    """Record that a migration has been applied."""
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL,
            applied_at DATETIME NOT NULL
        )
    ''')
    cursor.execute(
        'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
        (version, datetime.utcnow())
    )


def init_db():
    """Initialize the database with schema version checking and migrations."""
    os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)

    with get_db() as conn:
        cursor = conn.cursor()

        current_version = _get_schema_version(cursor)
        target_version = SCHEMA_TARGET_VERSION

        if current_version == target_version:
            logger.info(f"Database schema up to date (version {current_version})")
            return

        if current_version > target_version:
            logger.error(
                f"Database schema version ({current_version}) is newer than "
                f"application target ({target_version}). "
                "Refusing to downgrade — please update the application."
            )
            raise RuntimeError(
                f"Database schema version {current_version} is newer than "
                f"application version {target_version}"
            )

        logger.info(
            f"Database schema check: current version {current_version}, "
            f"target version {target_version}"
        )

        # Ensure schema_version table exists before recording migrations
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL,
                applied_at DATETIME NOT NULL
            )
        ''')

        # If this is a pre-versioning database, record its detected version
        # so migration history is complete.
        if current_version > 0:
            cursor.execute('SELECT COUNT(*) as cnt FROM schema_version')
            if cursor.fetchone()['cnt'] == 0:
                logger.info(
                    f"Pre-versioning database detected at version {current_version}, "
                    "recording baseline"
                )
                for v in range(1, current_version + 1):
                    _set_schema_version(cursor, v)

        # Apply pending migrations in order
        for version in range(current_version + 1, target_version + 1):
            migration_fn = MIGRATIONS.get(version)
            if migration_fn is None:
                logger.error(f"No migration function defined for version {version}")
                raise RuntimeError(f"Missing migration for version {version}")

            logger.info(
                f"Applying migration v{version - 1} -> v{version}: "
                f"{migration_fn.__doc__.strip() if migration_fn.__doc__ else 'no description'}"
            )
            migration_fn(cursor)
            _set_schema_version(cursor, version)
            logger.info(f"Migration v{version - 1} -> v{version} applied successfully")

        conn.commit()
        logger.info(
            f"Database schema updated to version {target_version} "
            f"(was version {current_version})"
        )


# =============================================================================
# DATA FETCHING - ENERGY
# =============================================================================

def get_item(collection, key, target):
    if not collection:
        return {}
    return next((item for item in collection if item.get(key) == target), {})


def parse_value(value):
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        cleaned = str(value).encode('ascii', 'ignore').decode('ascii').strip()
        return float(cleaned) if cleaned else 0.0
    except (ValueError, AttributeError):
        return 0.0


def fetch_and_store_data():
    """Fetch data from Statnett API"""
    global last_fetch_time, last_fetch_status

    logger.info("Fetching data from Statnett API...")

    try:
        response = requests.get(URL_CONSUMPTION, timeout=30)
        response.raise_for_status()
        data = response.json()

        timestamp = datetime.utcnow().replace(second=0, microsecond=0)

        with get_db() as conn:
            cursor = conn.cursor()

            for country_code in COUNTRIES.keys():
                consumption = parse_value(
                    get_item(data.get("ConsumptionData", []), "titleTranslationId",
                            f"ProductionConsumption.Consumption{country_code}Desc").get("value")
                )
                production = parse_value(
                    get_item(data.get("ProductionData", []), "titleTranslationId",
                            f"ProductionConsumption.Production{country_code}Desc").get("value")
                )
                exchange = parse_value(
                    get_item(data.get("NetExchangeData", []), "titleTranslationId",
                            f"ProductionConsumption.NetExchange{country_code}Desc").get("value")
                )

                import_val = exchange / 1000 if exchange >= 0 else 0
                export_val = abs(exchange) / 1000 if exchange < 0 else 0

                cursor.execute('''
                    INSERT OR REPLACE INTO energy_status
                    (timestamp, country, production, consumption, import_value, export_value)
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', (timestamp, country_code, production / 1000, consumption / 1000,
                      import_val, export_val))

                nuclear = parse_value(get_item(data.get("NuclearData", []), "titleTranslationId",
                            f"ProductionConsumption.Nuclear{country_code}Desc").get("value"))
                hydro = parse_value(get_item(data.get("HydroData", []), "titleTranslationId",
                            f"ProductionConsumption.Hydro{country_code}Desc").get("value"))
                wind = parse_value(get_item(data.get("WindData", []), "titleTranslationId",
                            f"ProductionConsumption.Wind{country_code}Desc").get("value"))
                thermal = parse_value(get_item(data.get("ThermalData", []), "titleTranslationId",
                            f"ProductionConsumption.Thermal{country_code}Desc").get("value"))
                not_specified = parse_value(get_item(data.get("NotSpecifiedData", []), "titleTranslationId",
                            f"ProductionConsumption.NotSpecified{country_code}Desc").get("value"))

                cursor.execute('''
                    INSERT OR REPLACE INTO energy_types
                    (timestamp, country, nuclear, hydro, wind, thermal, not_specified)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (timestamp, country_code, nuclear / 1000, hydro / 1000,
                      wind / 1000, thermal / 1000, not_specified / 1000))

            conn.commit()
            last_fetch_time = datetime.utcnow()
            last_fetch_status = "success"
            logger.info(f"Data stored for {timestamp}")

    except Exception as e:
        last_fetch_time = datetime.utcnow()
        last_fetch_status = "error"
        logger.error(f"Fetch failed: {e}")


# =============================================================================
# DATA FETCHING - NORDPOOL SPOT PRICES
# =============================================================================

NORDPOOL_API_URL = "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices"
NORDPOOL_API_TIMEOUT = 15
NORDPOOL_API_RETRIES = 3


def _fetch_nordpool_day(target_date, zones):
    """Fetch day-ahead prices from Nordpool API for a single date.
    Returns list of (timestamp_str, zone, price) tuples, or empty list on failure."""
    params = {
        'currency': 'EUR',
        'market': 'DayAhead',
        'date': target_date.strftime('%Y-%m-%d'),
        'deliveryArea': ','.join(zones),
    }

    last_err = None
    data = None
    for attempt in range(NORDPOOL_API_RETRIES):
        try:
            resp = requests.get(
                NORDPOOL_API_URL,
                params=params,
                timeout=NORDPOOL_API_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            logger.info(f"Nordpool API successful for {target_date}, got response with keys: {list(data.keys()) if isinstance(data, dict) else 'non-dict response'}")
            break
        except Exception as e:
            last_err = e
            if attempt < NORDPOOL_API_RETRIES - 1:
                import time
                time.sleep(2 ** attempt)
                logger.warning(f"Nordpool API attempt {attempt + 1} failed: {e}, retrying...")
            continue
    else:
        logger.error(f"Nordpool API failed after {NORDPOOL_API_RETRIES} attempts: {last_err}")
        return []

    if not data:
        logger.error("Nordpool API returned empty response")
        return []

    results = []
    # multiAreaEntries contains 15-min intervals; aggregate to hourly by
    # keeping the first 15-min price of each hour (prices are constant within
    # an hour for day-ahead auction).
    multi_area_entries = data.get('multiAreaEntries', [])

    if not multi_area_entries:
        logger.warning(f"No multiAreaEntries in Nordpool response for {target_date}. Response keys: {list(data.keys())}")
        # Log a sample of the response for debugging (first 500 chars)
        import json
        response_sample = json.dumps(data, default=str)[:500]
        logger.warning(f"Response sample: {response_sample}")

    seen_hours = {}  # (zone, hour_start) -> True
    for entry in multi_area_entries:
        delivery_start = entry.get('deliveryStart')
        if not delivery_start:
            continue
        for zone, price in entry.get('entryPerArea', {}).items():
            if zone not in zones:
                continue
            # Parse ISO timestamp and truncate to hour
            try:
                dt = datetime.fromisoformat(delivery_start.replace('Z', '+00:00'))
                hour_start = dt.replace(minute=0, second=0, microsecond=0)
            except (ValueError, AttributeError):
                continue
            key = (zone, hour_start)
            if key in seen_hours:
                continue
            seen_hours[key] = True
            try:
                price_val = float(price)
                if price_val != price_val or abs(price_val) > 1e6:
                    continue
            except (TypeError, ValueError):
                continue
            # Store as naive UTC datetime
            naive_utc = hour_start.replace(tzinfo=None)
            results.append((naive_utc, zone, price_val))

    logger.info(f"Extracted {len(results)} price records for {target_date}")
    return results


def fetch_and_store_prices():
    """Fetch spot prices from Nordpool day-ahead market (today + tomorrow)"""
    global last_price_fetch_time, last_price_fetch_status

    logger.info("Fetching spot prices from Nordpool...")

    try:
        all_zones = list(ZONE_TO_COUNTRY.keys())
        today = datetime.utcnow().date()
        tomorrow = today + timedelta(days=1)

        logger.info(f"Fetching prices for zones: {all_zones}")
        logger.info(f"Fetching prices for dates: {today}, {tomorrow}")

        all_results = []
        for target_date in [today, tomorrow]:
            day_results = _fetch_nordpool_day(target_date, all_zones)
            all_results.extend(day_results)
            logger.info(f"Fetched {len(day_results)} records for {target_date}")

        if not all_results:
            logger.error("CRITICAL: No price data returned from Nordpool API for any zone or date")
            logger.error(f"This means the correlation summary and current spot price will not display data")
            logger.error(f"Attempted to fetch for zones: {all_zones}")
            logger.error(f"Attempted to fetch for dates: {today}, {tomorrow}")
            logger.error(f"API URL: {NORDPOOL_API_URL}")
            last_price_fetch_status = "no_data"
            last_price_fetch_time = datetime.utcnow()
            return

        with get_db() as conn:
            cursor = conn.cursor()
            stored = 0

            for timestamp, zone_code, price in all_results:
                country = ZONE_TO_COUNTRY.get(zone_code)
                if not country:
                    logger.warning(f"Unknown zone: {zone_code}, skipping")
                    continue

                cursor.execute('''
                    INSERT OR REPLACE INTO spot_prices
                    (timestamp, country, zone, price, currency)
                    VALUES (?, ?, ?, ?, ?)
                ''', (timestamp, country, zone_code, price, 'EUR'))
                stored += 1

            conn.commit()
            last_price_fetch_time = datetime.utcnow()
            last_price_fetch_status = "success"
            logger.info(f"Successfully stored {stored} price records to database")

    except Exception as e:
        last_price_fetch_time = datetime.utcnow()
        last_price_fetch_status = "error"
        logger.error(f"Price fetch failed with exception: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")


def cleanup_old_data():
    cutoff = datetime.utcnow() - timedelta(days=DATA_RETENTION_DAYS)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM energy_status WHERE timestamp < ?', (cutoff,))
        cursor.execute('DELETE FROM energy_types WHERE timestamp < ?', (cutoff,))
        cursor.execute('DELETE FROM spot_prices WHERE timestamp < ?', (cutoff,))
        conn.commit()


# =============================================================================
# DATA FETCHING - EXCHANGE RATES
# =============================================================================

def fetch_exchange_rates():
    """Fetch EUR->SEK, EUR->DKK, EUR->NOK exchange rates from Frankfurter API (ECB data)"""
    global exchange_rates, last_exchange_rate_fetch_time, last_exchange_rate_fetch_status

    logger.info("Fetching exchange rates...")

    try:
        response = requests.get(
            'https://api.frankfurter.app/latest?from=EUR&to=SEK,DKK,NOK',
            timeout=15
        )
        response.raise_for_status()
        data = response.json()

        rates = data.get('rates', {})
        if 'SEK' in rates:
            exchange_rates['SEK'] = float(rates['SEK'])
        if 'DKK' in rates:
            exchange_rates['DKK'] = float(rates['DKK'])
        if 'NOK' in rates:
            exchange_rates['NOK'] = float(rates['NOK'])
        exchange_rates['EUR'] = 1.0

        last_exchange_rate_fetch_time = datetime.utcnow()
        last_exchange_rate_fetch_status = "success"
        logger.info(f"Exchange rates updated: EUR->SEK={exchange_rates['SEK']}, EUR->DKK={exchange_rates['DKK']}, EUR->NOK={exchange_rates['NOK']}")

    except Exception as e:
        last_exchange_rate_fetch_time = datetime.utcnow()
        last_exchange_rate_fetch_status = "error"
        logger.error(f"Exchange rate fetch failed: {e}")


def ensure_today_prices():
    """Check if today's prices exist in DB; if not, trigger a fetch"""
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT COUNT(*) as count FROM spot_prices
            WHERE timestamp >= ?
        ''', (today_start,))
        count = cursor.fetchone()['count']

    if count == 0:
        logger.info("No prices for today found, triggering price fetch...")
        fetch_and_store_prices()
        return True
    return False


# =============================================================================
# PUBLIC ROUTES
# =============================================================================

@app.route('/')
@limiter.limit("60 per minute")
def index():
    return render_template('index.html', countries=COUNTRIES)


@app.route('/api/countries')
@limiter.limit(RATE_LIMIT_API)
def get_countries():
    return jsonify(COUNTRIES)


@app.route('/api/zones/<country>')
@limiter.limit(RATE_LIMIT_API)
def get_zones(country):
    country = validate_country_code(country)
    if not country:
        return jsonify({'error': 'Invalid country code'}), 400
    return jsonify({
        'country': country,
        'zones': COUNTRY_ZONES.get(country, []),
        'default_zone': DEFAULT_ZONE.get(country)
    })


@app.route('/api/status/<country>')
@limiter.limit(RATE_LIMIT_API)
def get_status(country):
    country = validate_country_code(country)
    if not country:
        return jsonify({'error': 'Invalid country code'}), 400

    days = validate_days(request.args.get('days'), default=7)
    start_date = datetime.utcnow() - timedelta(days=days)

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT timestamp, production, consumption, import_value, export_value
            FROM energy_status WHERE country = ? AND timestamp >= ?
            ORDER BY timestamp ASC LIMIT 10000
        ''', (country, start_date))
        rows = cursor.fetchall()

    data = []
    for row in rows:
        ts = row['timestamp']
        if ts and 'T' not in ts:
            ts = ts.replace(' ', 'T')
        data.append({
            'timestamp': ts,
            'production': row['production'] or 0,
            'consumption': row['consumption'] or 0,
            'import': row['import_value'] or 0,
            'export': row['export_value'] or 0
        })

    return jsonify({
        'country': country,
        'country_name': COUNTRIES.get(country),
        'data': data
    })


@app.route('/api/types/<country>')
@limiter.limit(RATE_LIMIT_API)
def get_types(country):
    country = validate_country_code(country)
    if not country:
        return jsonify({'error': 'Invalid country code'}), 400

    days = validate_days(request.args.get('days'), default=7)
    start_date = datetime.utcnow() - timedelta(days=days)

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT timestamp, nuclear, hydro, wind, thermal, not_specified
            FROM energy_types WHERE country = ? AND timestamp >= ?
            ORDER BY timestamp ASC LIMIT 10000
        ''', (country, start_date))
        rows = cursor.fetchall()

    data = []
    for row in rows:
        ts = row['timestamp']
        if ts and 'T' not in ts:
            ts = ts.replace(' ', 'T')
        data.append({
            'timestamp': ts,
            'nuclear': row['nuclear'] or 0,
            'hydro': row['hydro'] or 0,
            'wind': row['wind'] or 0,
            'thermal': row['thermal'] or 0,
            'not_specified': row['not_specified'] or 0
        })

    return jsonify({
        'country': country,
        'country_name': COUNTRIES.get(country),
        'data': data
    })


@app.route('/api/prices/<country>')
@limiter.limit(RATE_LIMIT_API)
def get_prices(country):
    """Return spot price time series for a country/zone"""
    country = validate_country_code(country)
    if not country:
        return jsonify({'error': 'Invalid country code'}), 400

    days = validate_days(request.args.get('days'), default=7)
    zone = validate_zone(request.args.get('zone'), country)
    start_date = datetime.utcnow() - timedelta(days=days)

    with get_db() as conn:
        cursor = conn.cursor()
        if zone:
            cursor.execute('''
                SELECT timestamp, price, currency, zone
                FROM spot_prices WHERE country = ? AND zone = ? AND timestamp >= ?
                ORDER BY timestamp ASC LIMIT 10000
            ''', (country, zone, start_date))
        else:
            cursor.execute('''
                SELECT timestamp, AVG(price) as price, currency, 'AVG' as zone
                FROM spot_prices WHERE country = ? AND timestamp >= ?
                GROUP BY timestamp
                ORDER BY timestamp ASC LIMIT 10000
            ''', (country, start_date))
        rows = cursor.fetchall()

    data = []
    for row in rows:
        ts = row['timestamp']
        if ts and 'T' not in ts:
            ts = ts.replace(' ', 'T')
        price_mwh = row['price'] or 0
        data.append({
            'timestamp': ts,
            'price': price_mwh / 1000.0,
            'currency': row['currency'] or 'EUR',
            'zone': row['zone']
        })

    return jsonify({
        'country': country,
        'country_name': COUNTRIES.get(country),
        'zone': zone,
        'data': data
    })


@app.route('/api/prices/today/<country>')
@limiter.limit(RATE_LIMIT_API)
def get_today_prices(country):
    """Return today's and tomorrow's hourly spot prices for a zone, with freshness check"""
    country = validate_country_code(country)
    if not country:
        return jsonify({'error': 'Invalid country code'}), 400

    zone = validate_zone(request.args.get('zone'), country)
    if not zone:
        zone = DEFAULT_ZONE.get(country, 'SE3')

    # Ensure we have today's prices
    ensure_today_prices()

    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow_start = today_start + timedelta(days=1)
    day_after_tomorrow = tomorrow_start + timedelta(days=1)

    with get_db() as conn:
        cursor = conn.cursor()

        # Get today's prices
        cursor.execute('''
            SELECT timestamp, price, currency, zone
            FROM spot_prices WHERE zone = ? AND timestamp >= ? AND timestamp < ?
            ORDER BY timestamp ASC
        ''', (zone, today_start, tomorrow_start))
        today_rows = cursor.fetchall()

        # Get tomorrow's prices
        cursor.execute('''
            SELECT timestamp, price, currency, zone
            FROM spot_prices WHERE zone = ? AND timestamp >= ? AND timestamp < ?
            ORDER BY timestamp ASC
        ''', (zone, tomorrow_start, day_after_tomorrow))
        tomorrow_rows = cursor.fetchall()

    def format_rows(rows):
        result = []
        for row in rows:
            ts = row['timestamp']
            if ts and 'T' not in ts:
                ts = ts.replace(' ', 'T')
            price_mwh = row['price'] or 0
            result.append({
                'timestamp': ts,
                'price': price_mwh / 1000.0,
                'currency': row['currency'] or 'EUR',
                'zone': row['zone']
            })
        return result

    # Find current price (closest hour <= now)
    current_price = None
    now = datetime.utcnow()
    current_hour = now.replace(minute=0, second=0, microsecond=0)
    for row in reversed(today_rows):
        ts_str = row['timestamp']
        ts = datetime.strptime(ts_str.replace('T', ' ').split('.')[0], '%Y-%m-%d %H:%M:%S') if ts_str else None
        if ts and ts <= now:
            price_mwh = row['price'] or 0
            current_price = {
                'price': price_mwh / 1000.0,
                'currency': row['currency'] or 'EUR',
                'timestamp': ts_str.replace(' ', 'T') if ts_str and 'T' not in ts_str else ts_str
            }
            break

    return jsonify({
        'country': country,
        'country_name': COUNTRIES.get(country),
        'zone': zone,
        'today_date': today_start.strftime('%Y-%m-%d'),
        'tomorrow_date': tomorrow_start.strftime('%Y-%m-%d'),
        'today': format_rows(today_rows),
        'tomorrow': format_rows(tomorrow_rows) if tomorrow_rows else None,
        'current_price': current_price,
        'has_tomorrow': len(tomorrow_rows) > 0
    })


@app.route('/api/exchange-rates')
@limiter.limit(RATE_LIMIT_API)
def get_exchange_rates():
    """Return current exchange rates (EUR base)"""
    return jsonify({
        'base': 'EUR',
        'rates': exchange_rates,
        'last_updated': str(last_exchange_rate_fetch_time) if last_exchange_rate_fetch_time else None,
        'status': last_exchange_rate_fetch_status
    })


@app.route('/api/correlation/<country>')
@limiter.limit(RATE_LIMIT_API)
def get_correlation(country):
    """Return paired price/energy data with correlation coefficient"""
    country = validate_country_code(country)
    if not country:
        return jsonify({'error': 'Invalid country code'}), 400

    energy_type = validate_energy_type(request.args.get('energy_type'))
    if not energy_type:
        energy_type = 'wind'

    days = validate_days(request.args.get('days'), default=30)
    zone = validate_zone(request.args.get('zone'), country)
    if not zone:
        zone = DEFAULT_ZONE.get(country, 'SE3')

    start_date = datetime.utcnow() - timedelta(days=days)

    with get_db() as conn:
        cursor = conn.cursor()

        # Get price data
        cursor.execute('''
            SELECT timestamp, price FROM spot_prices
            WHERE zone = ? AND timestamp >= ?
            ORDER BY timestamp ASC
        ''', (zone, start_date))
        price_rows = cursor.fetchall()

        # Get energy type data aggregated to hourly
        # energy_type is validated against VALID_ENERGY_TYPES whitelist
        query = '''
            SELECT strftime('%%Y-%%m-%%d %%H:00:00', timestamp) as hour_ts,
                   AVG({col}) as energy_value
            FROM energy_types
            WHERE country = ? AND timestamp >= ?
            GROUP BY hour_ts
            ORDER BY hour_ts ASC
        '''.format(col=energy_type)
        cursor.execute(query, (country, start_date))
        energy_rows = cursor.fetchall()

    # Build energy lookup by hour
    energy_by_hour = {}
    for row in energy_rows:
        energy_by_hour[row['hour_ts']] = row['energy_value']

    # Pair data points
    paired = []
    prices_list = []
    energy_list = []

    for row in price_rows:
        ts = row['timestamp']
        hour_key = ts[:13] + ':00:00' if ts else None
        if hour_key and hour_key in energy_by_hour:
            price_val = row['price']
            energy_val = energy_by_hour[hour_key]
            if price_val is not None and energy_val is not None:
                display_ts = ts
                if display_ts and 'T' not in display_ts:
                    display_ts = display_ts.replace(' ', 'T')
                price_kwh = price_val / 1000.0
                paired.append({
                    'timestamp': display_ts,
                    'price': price_kwh,
                    'energy_value': energy_val
                })
                prices_list.append(price_kwh)
                energy_list.append(energy_val)

    r = pearson_correlation(energy_list, prices_list)
    r_squared = r ** 2 if r is not None else None

    return jsonify({
        'country': country,
        'country_name': COUNTRIES.get(country),
        'zone': zone,
        'energy_type': energy_type,
        'days': days,
        'data_points': len(paired),
        'correlation': {
            'r': round(r, 4) if r is not None else None,
            'r_squared': round(r_squared, 4) if r_squared is not None else None,
            'interpretation': interpret_correlation(r)
        },
        'data': paired
    })


@app.route('/api/correlation/summary/<country>')
@limiter.limit(RATE_LIMIT_API)
def get_correlation_summary(country):
    """Return correlation coefficients for all energy types vs price"""
    country = validate_country_code(country)
    if not country:
        return jsonify({'error': 'Invalid country code'}), 400

    days = validate_days(request.args.get('days'), default=30)
    zone = validate_zone(request.args.get('zone'), country)
    if not zone:
        zone = DEFAULT_ZONE.get(country, 'SE3')

    start_date = datetime.utcnow() - timedelta(days=days)

    with get_db() as conn:
        cursor = conn.cursor()

        # Get price data
        cursor.execute('''
            SELECT timestamp, price FROM spot_prices
            WHERE zone = ? AND timestamp >= ?
            ORDER BY timestamp ASC
        ''', (zone, start_date))
        price_rows = cursor.fetchall()

        # Build price lookup by hour (convert MWh to kWh)
        price_by_hour = {}
        for row in price_rows:
            ts = row['timestamp']
            hour_key = ts[:13] + ':00:00' if ts else None
            if hour_key:
                price_by_hour[hour_key] = (row['price'] or 0) / 1000.0

        # Get energy types aggregated to hourly
        cursor.execute('''
            SELECT strftime('%%Y-%%m-%%d %%H:00:00', timestamp) as hour_ts,
                   AVG(nuclear) as nuclear,
                   AVG(hydro) as hydro,
                   AVG(wind) as wind,
                   AVG(thermal) as thermal,
                   AVG(not_specified) as not_specified
            FROM energy_types
            WHERE country = ? AND timestamp >= ?
            GROUP BY hour_ts
            ORDER BY hour_ts ASC
        ''', (country, start_date))
        energy_rows = cursor.fetchall()

    # Calculate correlations for each energy type
    energy_types_list = ['nuclear', 'hydro', 'wind', 'thermal', 'not_specified']
    results = {}

    for et in energy_types_list:
        prices_list = []
        energy_list = []

        for row in energy_rows:
            hour_key = row['hour_ts']
            if hour_key in price_by_hour:
                price_val = price_by_hour[hour_key]
                energy_val = row[et]
                if price_val is not None and energy_val is not None:
                    prices_list.append(price_val)
                    energy_list.append(energy_val)

        r = pearson_correlation(energy_list, prices_list)
        results[et] = {
            'r': round(r, 4) if r is not None else None,
            'r_squared': round(r ** 2, 4) if r is not None else None,
            'data_points': len(prices_list),
            'interpretation': interpret_correlation(r)
        }

    return jsonify({
        'country': country,
        'country_name': COUNTRIES.get(country),
        'zone': zone,
        'days': days,
        'correlations': results
    })


@app.route('/api/current')
@limiter.limit(RATE_LIMIT_API)
def get_current():
    result = {}

    with get_db() as conn:
        cursor = conn.cursor()

        for country_code in COUNTRIES.keys():
            cursor.execute('''
                SELECT timestamp, production, consumption, import_value, export_value
                FROM energy_status WHERE country = ?
                ORDER BY timestamp DESC LIMIT 1
            ''', (country_code,))
            status = cursor.fetchone()

            cursor.execute('''
                SELECT nuclear, hydro, wind, thermal, not_specified
                FROM energy_types WHERE country = ?
                ORDER BY timestamp DESC LIMIT 1
            ''', (country_code,))
            types = cursor.fetchone()

            # Get latest spot price for default zone
            default_z = DEFAULT_ZONE.get(country_code)
            cursor.execute('''
                SELECT price, currency, zone, timestamp
                FROM spot_prices WHERE zone = ?
                ORDER BY timestamp DESC LIMIT 1
            ''', (default_z,))
            price_row = cursor.fetchone()

            if status and types:
                entry = {
                    'name': COUNTRIES[country_code],
                    'timestamp': status['timestamp'],
                    'status': {
                        'production': status['production'],
                        'consumption': status['consumption'],
                        'import': status['import_value'],
                        'export': status['export_value']
                    },
                    'types': {
                        'nuclear': types['nuclear'],
                        'hydro': types['hydro'],
                        'wind': types['wind'],
                        'thermal': types['thermal'],
                        'not_specified': types['not_specified']
                    }
                }
                if price_row:
                    price_mwh = price_row['price'] or 0
                    entry['price'] = {
                        'value': price_mwh / 1000.0,
                        'currency': price_row['currency'],
                        'zone': price_row['zone'],
                        'timestamp': price_row['timestamp']
                    }
                result[country_code] = entry

    return jsonify(result)


@app.route('/api/stats')
@limiter.limit(RATE_LIMIT_API)
def get_stats():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT COUNT(*) as count FROM energy_status')
        status_count = cursor.fetchone()['count']
        cursor.execute('SELECT COUNT(*) as count FROM spot_prices')
        price_count = cursor.fetchone()['count']
        cursor.execute('SELECT MAX(timestamp) as newest FROM energy_status')
        row = cursor.fetchone()

    return jsonify({
        'total_records': status_count,
        'price_records': price_count,
        'newest_record': row['newest']
    })


# =============================================================================
# INTERNAL-ONLY ROUTES
# =============================================================================

@app.route('/internal/health')
@internal_only
def health_check():
    try:
        with get_db() as conn:
            conn.execute('SELECT 1')
        return jsonify({'status': 'healthy'}), 200
    except Exception:
        return jsonify({'status': 'unhealthy'}), 500


@app.route('/internal/debug')
@internal_only
def get_debug():
    if not ENABLE_DEBUG_ENDPOINTS:
        abort(404)

    return jsonify({
        'scheduler_running': scheduler.running if scheduler else False,
        'last_fetch_time': str(last_fetch_time) if last_fetch_time else None,
        'last_fetch_status': last_fetch_status,
        'last_price_fetch_time': str(last_price_fetch_time) if last_price_fetch_time else None,
        'last_price_fetch_status': last_price_fetch_status,
        'last_exchange_rate_fetch_time': str(last_exchange_rate_fetch_time) if last_exchange_rate_fetch_time else None,
        'last_exchange_rate_fetch_status': last_exchange_rate_fetch_status,
        'exchange_rates': exchange_rates
    })


@app.route('/internal/fetch-now', methods=['POST'])
@internal_only
def trigger_fetch():
    if not ENABLE_DEBUG_ENDPOINTS:
        abort(404)
    fetch_and_store_data()
    fetch_and_store_prices()
    return jsonify({'success': True})


# =============================================================================
# ERROR HANDLERS
# =============================================================================

@app.errorhandler(400)
def bad_request(e):
    return jsonify({'error': 'Bad request'}), 400

@app.errorhandler(403)
def forbidden(e):
    return jsonify({'error': 'Forbidden'}), 403

@app.errorhandler(404)
def not_found(e):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(429)
def rate_limited(e):
    return jsonify({'error': 'Rate limit exceeded'}), 429

@app.errorhandler(500)
def internal_error(e):
    return jsonify({'error': 'Internal server error'}), 500


# =============================================================================
# SCHEDULER
# =============================================================================

def start_scheduler():
    global scheduler

    if scheduler is not None and scheduler.running:
        logger.info("Scheduler already running, skipping start")
        return

    scheduler = BackgroundScheduler(daemon=True)

    # Initial data fetch
    try:
        fetch_and_store_data()
    except Exception as e:
        logger.error(f"Initial data fetch failed: {e}")

    # Initial price fetch
    try:
        fetch_and_store_prices()
    except Exception as e:
        logger.error(f"Initial price fetch failed: {e}")

    # Initial exchange rate fetch
    try:
        fetch_exchange_rates()
    except Exception as e:
        logger.error(f"Initial exchange rate fetch failed: {e}")

    scheduler.add_job(fetch_and_store_data, 'interval',
                      minutes=FETCH_INTERVAL_MINUTES, id='fetch_data',
                      replace_existing=True)

    # Prices update hourly (day-ahead prices don't change that often)
    scheduler.add_job(fetch_and_store_prices, 'interval',
                      hours=1, id='fetch_prices',
                      replace_existing=True)

    # Exchange rates update 4 times a day (every 6 hours)
    scheduler.add_job(fetch_exchange_rates, 'interval',
                      hours=6, id='fetch_exchange_rates',
                      replace_existing=True)

    scheduler.add_job(cleanup_old_data, 'cron', hour=3, minute=0, id='cleanup',
                      replace_existing=True)

    scheduler.start()
    logger.info(f"Scheduler started - energy every {FETCH_INTERVAL_MINUTES} min, prices every 1 hour, exchange rates every 6 hours")


# =============================================================================
# INITIALIZATION (runs on import - works with Gunicorn)
# =============================================================================

def initialize_app():
    """Initialize database and scheduler - called on module load"""
    logger.info("Nordic Energy Dashboard initializing...")
    try:
        init_db()
        start_scheduler()
        logger.info("Initialization complete")
    except Exception as e:
        logger.error(f"Initialization failed: {e}")
        raise

# Initialize when module is loaded (for Gunicorn)
initialize_app()


# =============================================================================
# MAIN (for direct execution)
# =============================================================================

if __name__ == '__main__':
    # Already initialized above, just run the dev server
    app.run(host='0.0.0.0', port=5000, debug=False, use_reloader=False)
