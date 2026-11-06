/**
 * Cloud-drive document source for the KG build pipeline — contract for the
 * app-cloud M2M face (GET /internal/cloud/kg/documents + /internal/cloud/kg/document).
 *
 * Document text is owned by the cloud (app-cloud parses uploads and stores the
 * parsed text); app-ts only reads it, exactly like the ASR transcript source
 * (kg-sources.ts) reads the bili domain's Mongo collection. uid is a required
 * argument on every call — identity never comes from model-controlled input.
 *
 * Implementations: http/kg-cloud-sources.ts (production, AppCloudClient) ·
 * memory/kg-cloud-sources.ts (in-memory, tests / degraded fallback).
 */

export interface CloudDocMeta {
  uploadUuid: string;
  title: string;
  /** app-cloud content hash; "" when the service did not report one */
  contentHash: string;
  /** parsed text length in characters (0 when unknown) */
  sizeChars: number;
}

export interface CloudDocContent extends CloudDocMeta {
  /** parsed plain text; empty = not parsed yet (the build marks the doc failed) */
  text: string;
}

export interface CloudDocListPage {
  items: CloudDocMeta[];
  /** upload_uuid of the last row when the page is full (next-page cursor); null = no more */
  nextCursor: string | null;
}

export interface KgCloudSourceStore {
  /** documents with usable parsed text for this uid, upload_uuid ASC */
  listDocuments(uid: string, opts: { limit: number; cursor?: string }): Promise<CloudDocListPage>;
  /** one document's parsed text; undefined = missing / no parsed text (app-cloud 404) */
  getDocument(uid: string, uploadUuid: string): Promise<CloudDocContent | undefined>;
  close(): Promise<void>;
}
