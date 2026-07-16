# ====== Backend: FastAPI ======
FROM python:3.12-slim

LABEL app="mind-base-backend"

# Runtime system deps: curl (healthcheck), xz-utils (unpack static ffmpeg),
# ca-certificates (https). ffmpeg is NO LONGER apt-installed — its codec libs
# were the ~450MB bulk of the old image.
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    curl \
    xz-utils \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Static ffmpeg + ffprobe (~126MB, self-contained codecs) replace apt ffmpeg
# (~451MB layer). GPL build bundles all codecs — compatible with Bilibili
# aac/m4s audio used in the ASR pipeline (asr.py, content_fetcher.py).
#
# Source: BtbN/FFmpeg-Builds GitHub releases (GPL, linux64 = amd64). Hosted on
# GitHub's own CDN so it is reliable in GitHub Actions. The previous
# johnvansickle.com host started returning HTTP 415 to GH Actions datacenter
# IPs; curl --retry does not retry 4xx, so --retry-all-errors is added.
RUN curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 \
        https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz \
        -o /tmp/ffmpeg.tar.xz \
    && tar -xf /tmp/ffmpeg.tar.xz -C /tmp/ \
    && cp /tmp/ffmpeg-*/bin/ffmpeg /tmp/ffmpeg-*/bin/ffprobe /usr/local/bin/ \
    && chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
    && rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-* \
    && ffmpeg -version | head -1

WORKDIR /app

# Install Python dependencies
# Tip: for faster downloads in China, uncomment the mirror line below
#   --index-url https://pypi.tuna.tsinghua.edu.cn/simple
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# Copy application code
COPY app/ ./app/

# Create data directories
RUN mkdir -p /app/data /app/logs

# Non-root user
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
