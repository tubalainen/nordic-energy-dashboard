# Nordic Energy Dashboard - Hardened Dockerfile
FROM python:3.11-slim-bookworm

# Security: Don't run as root
# Create non-root user first
RUN groupadd -r appgroup && useradd -r -g appgroup -d /app -s /sbin/nologin appuser

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=UTC

WORKDIR /app

# Install system dependencies (minimal)
RUN apt-get update && apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy requirements first for layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ /app/

# Create data directory
RUN mkdir -p /data && chown -R appuser:appgroup /data /app

# Security: Remove unnecessary files
RUN find /app -type f -name "*.pyc" -delete \
    && find /app -type d -name "__pycache__" -delete

# Switch to non-root user
USER appuser

# Expose port (internal only - nginx will proxy)
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/api/stats')" || exit 1

# Run with gunicorn (production WSGI server)
# --preload ensures init_db and start_scheduler run once before forking
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--threads", "2", \
     "--worker-class", "gthread", "--worker-tmp-dir", "/dev/shm", \
     "--access-logfile", "-", "--error-logfile", "-", \
     "--capture-output", "--enable-stdio-inheritance", \
     "--preload", \
     "main:app"]
