import { MongoClient, type Collection, type Db, type Document as MongoDoc } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { AcademicSection } from "../academic.js";
import type {
  DocumentRevision,
  ResearchDocumentRevisionRepository,
} from "../research-document-revisions.js";

const log = createLogger("MONGO");

/** MongoDB collection of immutable manuscript snapshots. */
const REVISIONS = "academic_document_revisions";

/** Stored shape: entity fields plus _id (mirrors DocumentRevision.id). */
interface RevisionDoc extends MongoDoc {
  _id: string;
  uid: string;
  projectId: string;
  documentId: string;
  version: number;
  title: string;
  sections: AcademicSection[];
  reason?: string;
  createdAt: number;
}

function toDoc(revision: DocumentRevision): RevisionDoc {
  return {
    _id: revision.id,
    uid: revision.uid,
    projectId: revision.projectId,
    documentId: revision.documentId,
    version: revision.version,
    title: revision.title,
    sections: structuredClone(revision.sections),
    ...(revision.reason !== undefined ? { reason: revision.reason } : {}),
    createdAt: revision.createdAt,
  };
}

function toRevision(doc: RevisionDoc): DocumentRevision {
  return {
    id: doc._id,
    uid: doc.uid,
    projectId: doc.projectId,
    documentId: doc.documentId,
    version: doc.version,
    title: doc.title,
    sections: structuredClone(doc.sections),
    ...(doc.reason !== undefined ? { reason: doc.reason } : {}),
    createdAt: doc.createdAt,
  };
}

/**
 * MongoDB adapter for the manuscript version history. One write per snapshot;
 * a unique {uid, documentId, version} index makes version numbers safe under
 * concurrent snapshots (a duplicate insert fails instead of corrupting order).
 */
export class MongoResearchDocumentRevisionRepository implements ResearchDocumentRevisionRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly revisions: Collection<RevisionDoc>,
  ) {}

  static async connect(): Promise<MongoResearchDocumentRevisionRepository | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs, connectTimeoutMS: timeoutMs });
    try {
      await client.connect();
      const db = client.db(database);
      const revisions = db.collection<RevisionDoc>(REVISIONS);
      await revisions.createIndex({ uid: 1, documentId: 1, version: 1 }, { unique: true });
      return new MongoResearchDocumentRevisionRepository(client, db, revisions);
    } catch (err) {
      log.warn(
        "[DOCVERSION] Mongo " + REVISIONS + " connect failed: " + (err instanceof Error ? err.message : err),
      );
      await client.close().catch(() => {});
      return null;
    }
  }

  async create(revision: DocumentRevision): Promise<void> {
    await this.revisions.insertOne(toDoc(revision));
  }

  async listByDocument(uid: string, projectId: string, documentId: string): Promise<DocumentRevision[]> {
    const docs = await this.revisions
      .find({ uid, projectId, documentId }, { sort: { version: 1 } })
      .toArray();
    return docs.map(toRevision);
  }

  async get(uid: string, id: string): Promise<DocumentRevision | null> {
    const doc = await this.revisions.findOne({ _id: id, uid });
    return doc ? toRevision(doc) : null;
  }

  async latest(uid: string, documentId: string): Promise<DocumentRevision | null> {
    const doc = await this.revisions.findOne({ uid, documentId }, { sort: { version: -1 } });
    return doc ? toRevision(doc) : null;
  }

  async removeByProject(uid: string, projectId: string): Promise<number> {
    const result = await this.revisions.deleteMany({ uid, projectId });
    return result.deletedCount;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
