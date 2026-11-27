import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CloudFolderError, CloudFolderService, parseFolderPath } from "../src/services/cloud-folders.js";
import { OfficeExportService } from "../src/services/office/index.js";
import type { CommandRequest, CommandResult, CommandRunner } from "../src/services/office-render/process.js";
import {
  OfficeRenderError,
  SofficeRenderer,
  createOfficeRenderer,
  resolveBinary,
} from "../src/services/office-render/renderer.js";

/**
 * Agent export destinations: the "agent/" folder must be found or created once,
 * cached, and racy creations must not duplicate folders. Plus the renderer
 * pipeline driven by a fake runner (no binaries, no network).
 */

interface FolderRow {
  id: number;
  name: string;
  parent_id?: number;
}

class FakeFolderCloud {
  readonly configured = true;
  readonly rows: FolderRow[] = [];
  readonly listCalls: Array<number | undefined> = [];
  readonly createCalls: Array<{ name: string; parentId?: number }> = [];
  failCreate = false;
  private nextId = 1;

  seed(name: string, parentId?: number): number {
    const id = this.nextId++;
    this.rows.push({ id, name, ...(parentId !== undefined ? { parent_id: parentId } : {}) });
    return id;
  }

  async listFolders(_uid: string, parentId?: number): Promise<FolderRow[]> {
    this.listCalls.push(parentId);
    return this.rows.filter((row) => (row.parent_id ?? undefined) === parentId).map((row) => ({ ...row }));
  }

  async createFolder(_uid: string, name: string, parentId?: number): Promise<FolderRow> {
    this.createCalls.push({ name, ...(parentId !== undefined ? { parentId } : {}) });
    if (this.failCreate) throw new Error("boom");
    const id = this.seed(name, parentId);
    return { id, name, ...(parentId !== undefined ? { parent_id: parentId } : {}) };
  }
}

describe("parseFolderPath", () => {
  it("splits on both separators and trims segments", () => {
    expect(parseFolderPath(" 2026Q3 / 周报 ")).toEqual(["2026Q3", "周报"]);
    expect(parseFolderPath("a\\\\b")).toEqual(["a", "b"]);
    expect(parseFolderPath("")).toEqual([]);
    expect(parseFolderPath(undefined)).toEqual([]);
  });

  it("rejects empty, dot and oversized segments and deep paths", () => {
    expect(() => parseFolderPath("..")).toThrow(CloudFolderError);
    expect(() => parseFolderPath("a\\..\\b")).toThrow(/不能是/);
    expect(() => parseFolderPath("x".repeat(61))).toThrow(/过长/);
    expect(() => parseFolderPath("a/b/c/d/e/f/g")).toThrow(/层级过深/);
  });
});

describe("CloudFolderService", () => {
  it("creates agent/ when missing and reuses it afterwards", async () => {
    const cloud = new FakeFolderCloud();
    const service = new CloudFolderService({ cloud, rootFolder: "agent", now: () => 1_000 });
    const first = await service.ensurePath("7");
    expect(first.path).toBe("agent");
    expect(cloud.createCalls).toEqual([{ name: "agent" }]);
    const second = await service.ensurePath("7");
    expect(second.folderId).toBe(first.folderId);
    // cached: only the first resolution listed the root
    expect(cloud.listCalls).toHaveLength(1);
    expect(cloud.createCalls).toHaveLength(1);
  });

  it("reuses a folder created at registration (case-insensitive match)", async () => {
    const cloud = new FakeFolderCloud();
    const id = cloud.seed("Agent");
    const service = new CloudFolderService({ cloud, rootFolder: "agent" });
    const result = await service.ensurePath("7");
    expect(result.folderId).toBe(id);
    expect(cloud.createCalls).toHaveLength(0);
  });

  it("creates nested sub-folders under agent/", async () => {
    const cloud = new FakeFolderCloud();
    const agentId = cloud.seed("agent");
    const service = new CloudFolderService({ cloud, rootFolder: "agent" });
    const result = await service.ensurePath("7", "2026Q3/周报");
    expect(result.path).toBe("agent/2026Q3/周报");
    expect(cloud.createCalls).toEqual([
      { name: "2026Q3", parentId: agentId },
      { name: "周报", parentId: agentId + 1 },
    ]);
    expect(result.folderId).toBe(agentId + 2);
  });

  it("dedupes concurrent first-time resolutions (no duplicate folders)", async () => {
    const cloud = new FakeFolderCloud();
    const service = new CloudFolderService({ cloud, rootFolder: "agent" });
    const [a, b] = await Promise.all([service.ensurePath("7"), service.ensurePath("7")]);
    expect(a.folderId).toBe(b.folderId);
    expect(cloud.createCalls).toHaveLength(1);
  });

  it("reuses the winner folder when a parallel creator wins the race", async () => {
    const cloud = new FakeFolderCloud();
    const service = new CloudFolderService({ cloud, rootFolder: "agent" });
    const original = cloud.createFolder.bind(cloud);
    let first = true;
    cloud.createFolder = async (uid: string, name: string, parentId?: number) => {
      if (first) {
        first = false;
        cloud.seed(name, parentId);
        throw new Error("duplicate name");
      }
      return original(uid, name, parentId);
    };
    const result = await service.ensurePath("7");
    expect(result.folderId).toBe(1);
  });

  it("maps cloud failures to a cloud_unavailable error", async () => {
    const cloud = new FakeFolderCloud();
    const service = new CloudFolderService({ cloud, rootFolder: "agent" });
    cloud.listFolders = async () => {
      throw new Error("connection refused");
    };
    await expect(service.ensurePath("7")).rejects.toMatchObject({ code: "cloud_unavailable" });
  });

  it("refuses to resolve when app-cloud is not configured", async () => {
    const cloud = new FakeFolderCloud();
    (cloud as { configured: boolean }).configured = false;
    const service = new CloudFolderService({ cloud, rootFolder: "agent" });
    await expect(service.ensurePath("7")).rejects.toMatchObject({ code: "cloud_unavailable" });
  });
});

interface UploadCall {
  uid: string;
  folderId: number;
  name: string;
}

function exportServiceWith(cloud: FakeFolderCloud, uploads: UploadCall[]) {
  const folders = new CloudFolderService({ cloud, rootFolder: "agent" });
  const service = new OfficeExportService({
    cloud: {
      configured: true,
      async uploadFile(uid: string, folderId: number, name: string, data: Uint8Array) {
        uploads.push({ uid, folderId, name });
        return { upload_uuid: "u-1", name, size: data.byteLength };
      },
    },
    folders,
    now: () => new Date("2026-11-25T12:00:00Z"),
    timeZone: "Asia/Shanghai",
  });
  return service;
}

describe("OfficeExportService destination", () => {
  it("defaults to the agent/ folder", async () => {
    const cloud = new FakeFolderCloud();
    const uploads: UploadCall[] = [];
    const service = exportServiceWith(cloud, uploads);
    const result = await service.export("7", {
      format: "docx",
      title: "周报",
      docx: { blocks: [{ type: "paragraph", text: "内容" }] },
    });
    expect(result.folderId).toBe(cloud.rows[0].id);
    expect(result.folderLabel).toBe("agent");
    expect(uploads[0].folderId).toBe(cloud.rows[0].id);
    expect(uploads[0].name).toBe("周报_20261125-2000.docx");
  });

  it("honours folderPath under agent/ and an explicit folderId overrides it", async () => {
    const cloud = new FakeFolderCloud();
    const uploads: UploadCall[] = [];
    const service = exportServiceWith(cloud, uploads);
    const nested = await service.export("7", {
      format: "xlsx",
      title: "数据",
      xlsx: { sheets: [{ name: "S", rows: [[1]] }] },
      folderPath: "2026Q3",
    });
    expect(nested.folderLabel).toBe("agent/2026Q3");

    const explicit = await service.export("7", {
      format: "pptx",
      title: "汇报",
      pptx: { slides: [{ title: "封面" }] },
      folderId: 999,
    });
    expect(explicit.folderId).toBe(999);
    expect(explicit.folderLabel).toContain("999");
    expect(uploads[1].folderId).toBe(999);
  });

  it("turns folder errors into guidance-level domain errors", async () => {
    const cloud = new FakeFolderCloud();
    const uploads: UploadCall[] = [];
    const service = exportServiceWith(cloud, uploads);
    cloud.listFolders = async () => {
      throw new Error("down");
    };
    await expect(
      service.export("7", { format: "docx", title: "t", docx: { blocks: [{ type: "paragraph", text: "x" }] } }),
    ).rejects.toMatchObject({ code: "cloud_unavailable" });
    expect(uploads).toHaveLength(0);
  });
});

describe("cloud folder endpoint missing (old app-cloud)", () => {
  it("tags a 404 page-not-found as status 404", async () => {
    const cloud = new FakeFolderCloud();
    const service = new CloudFolderService({ cloud, rootFolder: "agent" });
    cloud.listFolders = async () => {
      const err = new Error("404 page not found");
      (err as unknown as { status: number }).status = 404;
      throw err;
    };
    await expect(service.ensurePath("7")).rejects.toMatchObject({ code: "cloud_unavailable", status: 404 });
  });

  it("office_export falls back to the drive root instead of failing", async () => {
    const uploads: UploadCall[] = [];
    const folders = {
      async ensurePath() {
        throw new CloudFolderError("cloud_unavailable", "云盘目录接口不可用（app-cloud 缺少接口）", 404);
      },
    } as unknown as CloudFolderService;
    const service = new OfficeExportService({
      cloud: {
        configured: true,
        async uploadFile(uid: string, folderId: number, name: string, data: Uint8Array) {
          uploads.push({ uid, folderId, name });
          return { upload_uuid: "u-1", name, size: data.byteLength };
        },
      },
      folders,
      now: () => new Date("2026-11-25T12:00:00Z"),
      timeZone: "Asia/Shanghai",
    });
    const result = await service.export("7", {
      format: "docx",
      title: "周报",
      docx: { blocks: [{ type: "paragraph", text: "内容" }] },
    });
    expect(result.folderId).toBe(0);
    expect(result.folderLabel).toContain("根目录");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].folderId).toBe(0);
  });
});
