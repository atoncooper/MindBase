# Derived APISIX image for MindBase.
#
# Adds one small static Go binary (apisix-sync) that bootstraps an empty etcd
# from the rendered declarative seed and keeps ssls/consumers (certificate and
# internal API-key rotation) in sync. Everything else is the stock upstream
# image, including its /docker-entrypoint.sh (which runs apisix init +
# init_etcd for traditional mode).
ARG APISIX_IMAGE=apache/apisix:3.20.0-debian

FROM golang:1.25-alpine AS build
ENV CGO_ENABLED=0
WORKDIR /src
COPY sync/go.mod sync/go.sum ./
RUN go mod download
COPY sync/main.go ./
RUN go build -trimpath -ldflags="-s -w" -o /out/apisix-sync .

FROM ${APISIX_IMAGE}
USER root
COPY --from=build /out/apisix-sync /usr/local/bin/apisix-sync
COPY entrypoint.sh /usr/local/bin/mindbase-apisix-entrypoint.sh
RUN chmod 0755 /usr/local/bin/apisix-sync /usr/local/bin/mindbase-apisix-entrypoint.sh
USER apisix
ENTRYPOINT ["/usr/local/bin/mindbase-apisix-entrypoint.sh"]
CMD ["docker-start"]
