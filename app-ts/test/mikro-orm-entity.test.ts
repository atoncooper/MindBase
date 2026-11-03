import { MikroORM } from "@mikro-orm/mongodb";
import { describe, expect, it } from "vitest";
import { AcademicEvidenceRecord } from "../src/repository/mongo/mikro/entities.js";

// Metadata-only test: no MongoDB connection is needed, so it runs in CI/offline.
describe("MikroORM academic evidence entity", () => {
  it("maps the existing collection and indexes", async () => {
    const orm = new MikroORM({
      entities: [AcademicEvidenceRecord],
      clientUrl: "mongodb://127.0.0.1:27017",
      dbName: "mind_base_ts",
    });
    try {
      const meta = orm.getMetadata().get("AcademicEvidenceRecord");
      expect(meta.collection).toBe("academic_runs");
      expect(meta.properties.id.fieldNames).toEqual(["_id"]);
      expect(meta.properties.files?.customType?.constructor?.name).toBe("JsonType");
      expect(meta.indexes).toEqual([
        { properties: ["uid", "projectId", "createdAt"] },
        { properties: ["uid", "projectId", "kind"] },
      ]);
    } finally {
      await orm.close(true);
    }
  });
});
