# Office eval / CI image: Debian bookworm + LibreOffice 7.4 + poppler + CJK fonts.
# Used by eval:office and golden generation; app-ts itself stays LibreOffice-free.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-impress-nogui libreoffice-calc-nogui \
      poppler-utils fonts-noto-cjk fonts-liberation \
 && rm -rf /var/lib/apt/lists/*