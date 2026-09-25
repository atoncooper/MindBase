# One-shot image for scripts/gen-certs.sh — needs an openssl CLI, which plain
# alpine lacks. Built once and cached; no network access at run time.
FROM alpine:3.20

RUN apk add --no-cache openssl

COPY gen-certs.sh /opt/gen-certs.sh
# Defense against CRLF working trees (git autocrlf on Windows): `` makes
# sh fail with "illegal option" on the shebang/set lines.
RUN sed -i 's/$//' /opt/gen-certs.sh

ENTRYPOINT ["/bin/sh", "/opt/gen-certs.sh"]
CMD ["all"]
