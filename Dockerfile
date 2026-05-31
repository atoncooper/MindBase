# ====== Backend: FastAPI (Alpine) ======
FROM python:3.12-alpine

LABEL app="bilibili-rag-backend"

# System dependencies
RUN apk add --no-cache \
    ffmpeg \
    curl \
    gcc musl-dev \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Install Python dependencies (leverage Docker layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && apk del gcc musl-dev

# Copy application code
COPY app/ ./app/

# Create data directories
RUN mkdir -p /app/data /app/logs

# Non-root user
RUN adduser -D -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
