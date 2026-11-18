# Optional sandbox runtime image with PowerShell + bash + Python.
#
# OpenSandbox creates every sandbox from SANDBOX__RUNTIME__IMAGE; the image is
# pulled/cached once and reused for all sandbox creations, so PowerShell is NOT
# installed per execution. Build and tag once from the repo root:
#
#   docker build -f app-go/app-sandbox/images/pwsh.Dockerfile -t mindbase/sandbox-pwsh:7.4 .
#   # .env
#   OPEN_SANDBOX_SANDBOX_IMAGE=mindbase/sandbox-pwsh:7.4
#
# The control plane itself still runs distroless; only execution sandboxes use
# this image. Debian's base already ships bash + pwsh; only Python is added.
FROM mcr.microsoft.com/powershell:7.4-debian-12

ENV DEBIAN_FRONTEND=noninteractive \
    POWERSHELL_TELEMETRY_OPTOUT=1 \
    POWERSHELL_UPDATECHECK=Off \
    DOTNET_CLI_TELEMETRY_OPTOUT=1

# Use a China mirror for the small Python install; deb.debian.org is frequently
# rate-limited/slow in the target deployment environment.
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# C.UTF-8 avoids the Debian base image's en_US.UTF-8 locale warnings in bash/pwsh.
# Keep this ENV after the apt layer so image rebuilds do not re-download packages.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
    && mkdir -p /workspace

WORKDIR /workspace
# OpenSandbox overrides the entrypoint with "tail -f /dev/null"; keep a shell.
CMD ["tail", "-f", "/dev/null"]
