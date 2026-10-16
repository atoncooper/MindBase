import { MongoClient, type Db, type Collection } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { QuizResumePlan, QuizResumeStore } from "../quiz-resume.js";

const log = createLogger("MONGO");

interface ResumeDoc {
  _id: string;
  quizUuid: string;
  uid: string;
  mode: "free" | "wrong_answers";
  topic: string;
  style?: string;
  instructions?: string;
  questionCount: number;
  distribution: Record<string, number>;
  difficulty: string;
  createdAt: number;
}

function toPlan(doc: ResumeDoc): QuizResumePlan {
  return {
    quizUuid: doc.quizUuid,
    uid: doc.uid,
    mode: doc.mode,
    topic: doc.topic,
    style: doc.style,
    instructions: doc.instructions,
    questionCount: doc.questionCount,
    distribution: doc.distribution,
    difficulty: doc.difficulty,
    createdAt: doc.createdAt,
  };
}

/** Mongo 实现（app-ts 自有库 mind_base_ts 的 quiz_resume_plans 集合）。 */
export class MongoQuizResumeStore implements QuizResumeStore {
  private readonly plans: Collection<ResumeDoc>;

  private constructor(
    private readonly client: MongoClient,
    db: Db,
  ) {
    this.plans = db.collection<ResumeDoc>("quiz_resume_plans");
  }

  static async connect(): Promise<MongoQuizResumeStore | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      const db = client.db(database);
      const store = new MongoQuizResumeStore(client, db);
      await store.plans.createIndex({ uid: 1, quizUuid: 1 }, { unique: true });
      return store;
    } catch (err) {
      log.warn(`[MONGO] quiz-resume connect failed, falls back to memory: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  async save(plan: QuizResumePlan): Promise<void> {
    const doc: ResumeDoc = { _id: plan.uid + ":" + plan.quizUuid, ...plan };
    await this.plans.replaceOne({ _id: doc._id }, doc, { upsert: true });
  }

  async get(uid: string, quizUuid: string): Promise<QuizResumePlan | null> {
    const doc = await this.plans.findOne({ _id: uid + ":" + quizUuid });
    return doc ? toPlan(doc) : null;
  }

  async remove(uid: string, quizUuid: string): Promise<void> {
    await this.plans.deleteOne({ _id: uid + ":" + quizUuid });
  }
}
