import { MilvusClient, type ClientConfig } from "@zilliz/milvus2-sdk-node";
import { config } from "../config/index.js";

/**
 * Milvus gRPC client factory (outbound connection layer).
 *
 * Internal Milvus traffic is TLS-only (proxy gRPC, one-way TLS: the server
 * presents a cert issued by the shared dev CA). Keep every MilvusClient in the
 * process built from this factory so TLS trust/SNI cannot drift between the
 * chunk store and the KG entity index.
 */
export function milvusClientConfig(): ClientConfig {
  return {
    address: config.milvus.address,
    token: config.milvus.token || undefined,
    database: config.milvus.database,
    timeout: 10_000,
    // `ssl` alone already implies one-way TLS; rootCertPath adds explicit CA
    // trust and serverName pins the SNI/SAN (the address is an IP-less alias).
    ssl: config.milvus.ssl,
    tls: config.milvus.ssl
      ? {
          ...(config.milvus.tlsRootCert ? { rootCertPath: config.milvus.tlsRootCert } : {}),
          ...(config.milvus.tlsServerName ? { serverName: config.milvus.tlsServerName } : {}),
        }
      : undefined,
  };
}

export function createMilvusClient(): MilvusClient {
  return new MilvusClient(milvusClientConfig());
}
