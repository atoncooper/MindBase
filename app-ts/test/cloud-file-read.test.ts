import { describe, expect, it } from "vitest";
import { createCloudFileReadTool } from "../src/tools/cloud/index.js";
import { ResultCollector } from "../src/context/types.js";
import type { ToolRunContext } from "../src/context/types.js";
import type { CloudKgDocument } from "../src/clients/app-cloud-client.js";

const UUID = "1f2e3d4c-5b6a-4789-8abc-def012345678";

function ctx(uid: string | undefined): ToolRunContext {
  return { uid, scope: {}, collector: new ResultCollector() };
}

function toolFor(doc: CloudKgDocument | undefined, configured = true) {
  return createCloudFileReadTool({
    configured,
    getKgDocument: async () => doc,
  });
}

describe("cloud_file_read", () => {
  it("pages the parsed source text with offset/limit", async () => {
    const tool = toolFor({
      upload_uuid: UUID,
      title: "架构说明.pdf",
      content_hash: "h1",
      size_chars: 10,
      text: "0123456789",
    });
    const out = await tool.execute({ uploadUuid: UUID, offset: 2, limit: 3 }, ctx("42"));
    expect(out).toContain("【云盘源文件】架构说明.pdf");
    expect(out).toContain("总字数：10");
    expect(out).toContain("本次返回：2-5");
    expect(out).toContain("234");
    expect(out).toContain("offset=5");
  });

  it("returns the whole body plus a no-more hint on the last page", async () => {
    const tool = toolFor({
      upload_uuid: UUID,
      title: "",
      content_hash: "",
      size_chars: 5,
      text: "hello",
    });
    const out = await tool.execute({ uploadUuid: UUID }, ctx("42"));
    expect(out).toContain("hello");
    expect(out).not.toContain("还有后续内容");
  });

  it("explains when no parsed source exists instead of inventing text", async () => {
    const out = await toolFor(undefined).execute({ uploadUuid: UUID }, ctx("42"));
    expect(out).toContain("没有读到可用的源正文");
  });

  it("requires uid and configured cloud access", async () => {
    const tool = toolFor(undefined);
    expect(await tool.execute({ uploadUuid: UUID }, ctx(undefined))).toContain("没有用户身份");
    expect(
      await createCloudFileReadTool({ configured: false, getKgDocument: async () => undefined }).execute(
        { uploadUuid: UUID },
        ctx("42"),
      ),
    ).toContain("未配置");
  });
});
