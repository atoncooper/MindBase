import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createLogger } from "../logger.js";

const log = createLogger("GRPC");

/**
 * Generic gRPC client infrastructure — the service-to-service transport layer,
 * the gRPC counterpart of src/mcp/client.ts (protocol clients live in their
 * own layer; repository/service code never touches transport details).
 *
 * Responsibilities (and nothing else):
 * - runtime proto loading (no codegen step; the .proto file is the contract)
 * - channel construction + connection options
 * - promisified unary calls with a per-call deadline
 * - ServiceError → Error normalization (method + code + details)
 *
 * Message↔domain mapping belongs to the caller (repository/grpc/* adapters);
 * the HTTP M2M counterpart is ./internal-client.ts.
 */

export interface GrpcClientOptions {
  /** host:port of the gRPC server */
  target: string;
  /** path to the .proto file (cwd-relative for local run; packaged with the image) */
  protoPath: string;
  /** fully-qualified service name inside the proto package, e.g. "kg.v1.KgGraph" */
  serviceFqn: string;
  /** per-call deadline applied by call() */
  timeoutMs: number;
  /** extra grpc channel options */
  channelOptions?: Record<string, unknown>;
}

type UnaryCallback = (err: grpc.ServiceError | null, response: Record<string, unknown>) => void;

type UnaryCall = (
  request: Record<string, unknown>,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: UnaryCallback,
) => void;

export class GrpcClient {
  private readonly methods: Record<string, UnaryCall>;

  private constructor(
    private readonly client: grpc.Client,
    private readonly timeoutMs: number,
    methods: Record<string, UnaryCall>,
  ) {
    this.methods = methods;
  }

  /** Load the proto, resolve the service constructor and open the channel.
   * Throws on any failure — the caller decides whether that means
   * "feature disabled" or "fatal". */
  static async create(opts: GrpcClientOptions): Promise<GrpcClient> {
    const definition = await protoLoader.load(opts.protoPath, {
      keepCase: false, // wire snake_case → camelCase keys
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [],
    });
    const pkg = grpc.loadPackageDefinition(definition) as unknown as Record<string, unknown>;
    const serviceType = resolveService(pkg, opts.serviceFqn);
    if (typeof serviceType !== "function") {
      throw new Error(`proto ${opts.protoPath} does not define service ${opts.serviceFqn}`);
    }
    const ServiceCtor = serviceType as unknown as new (
      target: string,
      credentials: grpc.ChannelCredentials,
      options?: Record<string, unknown>,
    ) => grpc.Client;
    const client = new ServiceCtor(opts.target, grpc.credentials.createInsecure(), {
      "grpc.keepalive_time_ms": 30_000,
      ...opts.channelOptions,
    });
    const methods = (client as unknown as Record<string, unknown>) as Record<string, UnaryCall>;
    log.info(`[GRPC] channel open target=${opts.target} service=${opts.serviceFqn}`);
    return new GrpcClient(client, opts.timeoutMs, methods);
  }

  /** Promisified unary RPC with deadline; rejects with a normalized Error
   * carrying method, grpc code and server details. */
  call<T = Record<string, unknown>>(method: string, request: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const protoMethod = this.methods[method];
      if (typeof protoMethod !== "function") {
        reject(new Error(`unknown grpc method: ${method}`));
        return;
      }
      const deadline = new Date(Date.now() + this.timeoutMs);
      protoMethod.call(
        this.client,
        request,
        new grpc.Metadata(),
        { deadline },
        (err, response) => {
          if (err) {
            reject(new Error(`${method} failed: ${err.code} ${err.details ?? err.message}`));
          } else {
            resolve(response as T);
          }
        },
      );
    });
  }

  close(): void {
    this.client.close();
  }
}

/** Walk a dotted FQN ("kg.v1.KgGraph") through the loaded package object. */
function resolveService(pkg: Record<string, unknown>, fqn: string): unknown {
  let node: unknown = pkg;
  for (const part of fqn.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
