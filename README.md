# Nordic Energy Dashboard - Security Hardened Edition

A security-hardened web application for visualizing Nordic power grid energy data, designed to run behind your existing Nginx reverse proxy and Cloudflare, while also being accessible on your local LAN.

## Architecture

```
Internet → Cloudflare → Your Nginx → Docker App (port 5050)
                                          ↑
LAN Users ────────────────────────────────┘
```

## Quick Start

```bash
# Extract and enter directory
unzip nordic-energy-dashboard-secure.zip
cd nordic-energy-dashboard-secure

# Start the container
docker-compose up -d

# Verify it's running
docker-compose ps
docker-compose logs -f
```

**Access:**
- LAN: `http://<your-docker-host>:5050`
- Internet: Via your nginx reverse proxy + Cloudflare

The app listens on port 5050 and is accessible from your local network. Configure nginx to proxy external traffic to it.

---

## Nginx Configuration

Add this to your existing nginx configuration:

### Basic Server Block

```nginx
server {
    listen 443 ssl http2;
    server_name energy.yourdomain.com;

    # SSL handled by Cloudflare or your certs
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;

    # Block access to internal endpoints
    location /internal {
        deny all;
        return 404;
    }

    # Block common exploit paths
    location ~* (\.php|\.asp|\.aspx|\.jsp|\.cgi|\.env|\.git)$ {
        deny all;
        return 404;
    }

    location ~* (wp-admin|wp-content|phpMyAdmin|actuator) {
        deny all;
        return 404;
    }

    # Rate limiting for API
    location /api/ {
        limit_req zone=api_limit burst=20 nodelay;
        
        # Update IP if nginx is on different host than Docker
        proxy_pass http://YOUR_DOCKER_HOST:5050;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Pass Cloudflare real IP
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        
        # Timeouts
        proxy_connect_timeout 10s;
        proxy_send_timeout 10s;
        proxy_read_timeout 30s;
    }

    # Static files (optional - can also let Flask serve them)
    location /static/ {
        proxy_pass http://YOUR_DOCKER_HOST:5050;
        proxy_http_version 1.1;
        expires 1h;
        add_header Cache-Control "public, immutable";
    }

    # Main application
    location / {
        limit_req zone=general_limit burst=30 nodelay;
        
        proxy_pass http://YOUR_DOCKER_HOST:5050;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
    }

    # Health check (restrict to internal/monitoring IPs)
    location = /internal/health {
        allow 127.0.0.1;
        allow 10.0.0.0/8;      # Adjust to your monitoring IP range
        allow 172.16.0.0/12;
        allow 192.168.0.0/16;
        deny all;
        
        proxy_pass http://YOUR_DOCKER_HOST:5050;
        proxy_set_header X-Internal-Request "true";
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name energy.yourdomain.com;
    return 301 https://$server_name$request_uri;
}
```

**Note:** Replace `YOUR_DOCKER_HOST` with your Docker host IP (e.g., `192.168.21.x`, `docker06`, or `127.0.0.1` if nginx is on the same host).

### Rate Limiting Zone (add to http block)

```nginx
http {
    # Rate limiting zones
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=general_limit:10m rate=30r/s;
    
    # Connection limits
    limit_conn_zone $binary_remote_addr zone=conn_limit:10m;
    
    # ... rest of your http config
}
```

### Using Cloudflare Real IP

If you're behind Cloudflare, add this to properly log/rate-limit by real client IP:

```nginx
# In http block - set real IP from Cloudflare
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 131.0.72.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
# IPv6
set_real_ip_from 2400:cb00::/32;
set_real_ip_from 2606:4700::/32;
set_real_ip_from 2803:f800::/32;
set_real_ip_from 2405:b500::/32;
set_real_ip_from 2405:8100::/32;
set_real_ip_from 2a06:98c0::/29;
set_real_ip_from 2c0f:f248::/32;

real_ip_header CF-Connecting-IP;
```

---

## Cloudflare Configuration

### SSL/TLS Settings

| Setting | Recommended Value |
|---------|------------------|
| SSL/TLS encryption mode | **Full (strict)** |
| Always Use HTTPS | **On** |
| Minimum TLS Version | **TLS 1.2** |
| TLS 1.3 | **On** |
| Automatic HTTPS Rewrites | **On** |

### Security Settings

| Setting | Recommended Value |
|---------|------------------|
| Security Level | **Medium** or **High** |
| Bot Fight Mode | **On** |
| Browser Integrity Check | **On** |
| Challenge Passage | **30 minutes** |

### WAF (Web Application Firewall)

Enable these managed rulesets:
- **Cloudflare Managed Ruleset** - On
- **Cloudflare OWASP Core Ruleset** - On

### Rate Limiting Rules

Create these rate limiting rules in **Security → WAF → Rate limiting rules**:

#### Rule 1: API Rate Limit
```
If: URI Path contains "/api/"
Then: Block for 60 seconds
Rate: 60 requests per 1 minute
```

#### Rule 2: General Rate Limit
```
If: URI Path equals "/" OR URI Path starts with "/static/"
Then: Block for 60 seconds  
Rate: 120 requests per 1 minute
```

### Page Rules (Optional)

| URL Pattern | Setting |
|-------------|---------|
| `*yourdomain.com/static/*` | Cache Level: Cache Everything, Edge TTL: 1 day |
| `*yourdomain.com/api/*` | Cache Level: Bypass, Security Level: High |

### Firewall Rules

Block known bad patterns:

```
Rule 1: Block sensitive paths
If: (http.request.uri.path contains ".env") or 
    (http.request.uri.path contains ".git") or 
    (http.request.uri.path contains "wp-admin") or
    (http.request.uri.path contains "phpMyAdmin")
Then: Block
```

```
Rule 2: Block non-browser user agents (optional, may block legitimate bots)
If: (not http.user_agent contains "Mozilla") and 
    (not http.user_agent contains "curl") and
    (http.request.uri.path contains "/api/")
Then: Challenge (Managed Challenge)
```

---

## Application Security Features

### Built-in Protections

| Feature | Description |
|---------|-------------|
| Input validation | Strict whitelist for country codes (SE, NO, FI, DK only) |
| Parameter bounds | Days parameter limited to 1-200 |
| Rate limiting | Flask-Limiter (30 req/min API, 100 req/min default) |
| Security headers | CSP, X-Frame-Options, X-Content-Type-Options |
| Path filtering | Blocks `.php`, `.env`, `wp-admin`, etc. |
| SQL injection prevention | Parameterized queries + CHECK constraints |
| Error handling | Generic messages only (no stack traces) |
| Request size limit | 1MB maximum |

### Internal Endpoints (Blocked Externally)

These routes require `X-Internal-Request: true` header:

| Endpoint | Description |
|----------|-------------|
| `/internal/health` | Health check for monitoring |
| `/internal/debug` | Debug info (disabled by default) |
| `/internal/fetch-now` | Manual data fetch (disabled by default) |

Access from your server:
```bash
curl -H "X-Internal-Request: true" http://127.0.0.1:5050/internal/health
```

---

## Docker Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_PATH` | `/data/energy.db` | Database location |
| `FETCH_INTERVAL` | `5` | Data fetch interval (minutes) |
| `DATA_RETENTION_DAYS` | `200` | Data retention period |
| `LOG_LEVEL` | `WARNING` | Logging level |
| `ENABLE_DEBUG_ENDPOINTS` | `false` | Enable debug routes |
| `RATE_LIMIT_API` | `30 per minute` | API rate limit |

### Container Security

- **Read-only filesystem** - Only `/tmp` and `/data` writable
- **No capabilities** - All Linux capabilities dropped
- **No privilege escalation** - `no-new-privileges` enabled
- **Non-root user** - Runs as `appuser`

### Port Binding

Default: `5050:5000` (accessible from LAN)

To restrict to localhost only (more secure if nginx is on same host):
```yaml
ports:
  - "127.0.0.1:5050:5000"
```

To change the external port:
```yaml
ports:
  - "YOUR_PORT:5000"
```

---

## Operations

### Starting/Stopping

```bash
docker-compose up -d      # Start
docker-compose down       # Stop
docker-compose restart    # Restart
docker-compose logs -f    # View logs
```

### Health Check

```bash
# Local check
curl http://127.0.0.1:5050/api/stats

# With internal header
curl -H "X-Internal-Request: true" http://127.0.0.1:5050/internal/health
```

### Backup Database

```bash
# Create backup
docker run --rm -v nordic_energy_data:/data -v $(pwd):/backup alpine \
  tar czf /backup/energy-backup-$(date +%Y%m%d).tar.gz -C /data .

# Restore
docker-compose down
docker run --rm -v nordic_energy_data:/data -v $(pwd):/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/energy-backup-YYYYMMDD.tar.gz -C /data"
docker-compose up -d
```

### Update Container

```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

---

## Security Checklist

- [ ] `ENABLE_DEBUG_ENDPOINTS=false` in production
- [ ] `LOG_LEVEL=WARNING` after initial setup
- [ ] Nginx blocks `/internal/*` paths from internet
- [ ] Cloudflare SSL set to "Full (strict)"
- [ ] Cloudflare WAF enabled
- [ ] Cloudflare rate limiting configured
- [ ] Nginx rate limiting configured
- [ ] Real IP from Cloudflare configured in nginx
- [ ] Consider firewall rules to limit port 5050 access to trusted LAN IPs only

---

## Troubleshooting

### Container won't start
```bash
docker-compose logs
# Check for port conflicts
netstat -tlnp | grep 5050
```

### 502 Bad Gateway from nginx
```bash
# Check if container is running
docker-compose ps
# Check container logs
docker-compose logs
# Test direct connection
curl http://127.0.0.1:5050/api/stats
```

### Rate limit errors
- Check Cloudflare rate limiting rules
- Check nginx rate limiting configuration
- Adjust `RATE_LIMIT_API` environment variable

### No data in charts
```bash
# Check scheduler is running
docker-compose logs | grep -i fetch
# Check Statnett API is reachable from container
docker exec nordic-energy-dashboard curl -s https://driftsdata.statnett.no/restapi/ProductionConsumption/GetLatestDetailedOverview | head -c 200
```
