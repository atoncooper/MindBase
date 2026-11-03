/**
 * Lazily-initialised MikroORM instance for the app-ts Mongo adapters.
 *
 * MikroORM 7 requires Node >= 22.17 and uses the same mongodb driver major as
 * app-ts (v7), so it does not introduce a second BSON/driver copy. The Mongo
 * deployment may be a standalone server (compose default), therefore
 * implicitTransactions is disabled: a unit of work never opens a transaction
 * that the server cannot provide.
 */
import { MikroORM } from "@mikro-orm/mongodb";
import { config } from "../../../config/index.js";
import { createLogger } from "../../../logger.js";
import { AcademicEvidenceRecord } from "./entities.js";

const log = createLogger("MONGO");

let instance: Promise<MikroORM | null> | undefined;

/** Shared, lazily connected ORM; null when Mongo is unconfigured/unreachable. */
export function getAcademicEvidenceOrm(): Promise<MikroORM | null> {
  instance ??= connectAcademicEvidenceOrm();
  return instance;
}

async function connectAcademicEvidenceOrm(): Promise<MikroORM | null> {
  const { uri, database, timeoutMs } = config.mongo;
  if (!uri) return null;

  let orm: MikroORM | undefined;
  try {
    orm = await MikroORM.init({
      entities: [AcademicEvidenceRecord],
      clientUrl: uri,
      dbName: database,
      implicitTransactions: false,
      // Indexes are created explicitly below so a failed index build is logged
      // here instead of surfacing from the first query.
      ensureIndexes: false,
      driverOptions: {
        serverSelectionTimeoutMS: timeoutMs,
        connectTimeoutMS: timeoutMs,
      },
    });
    const client = (orm.em.getConnection() as unknown as { getClient(): { db(name: string): { command(cmd: object): Promise<unknown> } } }).getClient();
    await client.db("admin").command({ ping: 1 });
    await orm.schema.ensureIndexes();
    log.info(`[MONGO] MikroORM academic evidence ready db=${database}`);
    return orm;
  } catch (err) {
    log.warn(`[MONGO] MikroORM init failed: ${err instanceof Error ? err.message : err}`);
    await orm?.close(true).catch(() => undefined);
    return null;
  }
}
