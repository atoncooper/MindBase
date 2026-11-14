# Optional sandbox runtime image with PowerShell + Python + common CLI tools.
#
# OpenSandbox creates every sandbox from SANDBOX__RUNTIME__IMAGE; the image is
# pulled/cached once and reused for all sandbox creations, so PowerShell is NOT
# installed per execution. Build and tag once:
#
#   docker build -f app-go/app-sandbox/images/pwsh.Dockerfile -t mindbase/sandbox-pwsh:7.4 .
#   # .env
#   OPEN_SANDBOX_SANDBOX_IMAGE=mindbase/sandbox-pwsh:7.4
#
# The control plane itself still runs distroless; only execution sandboxes use
# this image.
FROM mcr.microsoft.com/powershell:7.4-debian-12

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv git ripgrep jq curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
    && mkdir -p /workspace

WORKDIR /workspace
# OpenSandbox overrides the entrypoint with "tail -f /dev/null"; keep a shell.
CMD ["tail", "-f", "/dev/null"]
