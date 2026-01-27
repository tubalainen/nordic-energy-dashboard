#!/usr/bin/env python3
"""
Nordic Energy Dashboard - Main Application (Hardened)
Security-hardened version for production deployment
"""

import os
import sys
import sqlite3
import logging
import re
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
        "img-src 'self' data:; "
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


def init_db():
    """Initialize the database"""
    os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
    
    with get_db() as conn:
        cursor = conn.cursor()
        
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
        
        conn.commit()
        logger.info("Database initialized")


# =============================================================================
# DATA FETCHING
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


def cleanup_old_data():
    cutoff = datetime.utcnow() - timedelta(days=DATA_RETENTION_DAYS)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM energy_status WHERE timestamp < ?', (cutoff,))
        cursor.execute('DELETE FROM energy_types WHERE timestamp < ?', (cutoff,))
        conn.commit()


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
            
            if status and types:
                result[country_code] = {
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
    
    return jsonify(result)


@app.route('/api/stats')
@limiter.limit(RATE_LIMIT_API)
def get_stats():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT COUNT(*) as count FROM energy_status')
        status_count = cursor.fetchone()['count']
        cursor.execute('SELECT MAX(timestamp) as newest FROM energy_status')
        row = cursor.fetchone()
        
    return jsonify({
        'total_records': status_count,
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
        'last_fetch_status': last_fetch_status
    })


@app.route('/internal/fetch-now', methods=['POST'])
@internal_only
def trigger_fetch():
    if not ENABLE_DEBUG_ENDPOINTS:
        abort(404)
    fetch_and_store_data()
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
    
    scheduler.add_job(fetch_and_store_data, 'interval', 
                      minutes=FETCH_INTERVAL_MINUTES, id='fetch_data',
                      replace_existing=True)
    scheduler.add_job(cleanup_old_data, 'cron', hour=3, minute=0, id='cleanup',
                      replace_existing=True)
    
    scheduler.start()
    logger.info(f"Scheduler started - fetching every {FETCH_INTERVAL_MINUTES} min")


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
