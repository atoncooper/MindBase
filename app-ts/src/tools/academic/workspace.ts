import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import { isDocxFile, parseDocxSections } from "../../doc-parser/docx.js";
import type { ResearchFolderKind, ResearchWorkspaceService } from "../../services/research-workspace.js";

/**
 * research_workspace: 学术研究空间 → 论文题目/课题的云盘目录树 + 文件读取。
 *
 * The file bytes live in app-cloud; this tool creates the folder hierarchy,
 * returns folder ids so later uploads/experiments/manuscripts land in the right
 * directory, and (read_file) extracts a text preview of a project file so the
 * agent can inspect a Word template / data file before acting on it.
 */

/** Project folder order used when locating a file by name or upload_uuid. */
const WORKSPACE_FOLDER_KINDS: readonly ResearchFolderKind[] = [
  "plan",
  "literature",
  "data",
  "code",
  "results",
  "manuscript",
  "submission",
];

/** Cloud text reads are clamped so one tool result cannot flood the model context. */
const MAX_READ_CHARS = 8000;

/** Extensions decoded as UTF-8 text (docx is parsed through parseDocxSections). */
const PLAIN_TEXT_EXTENSIONS = /\.(md|markdown|txt)$/i;

/** One cloud file row as returned by ResearchWorkspaceService.listFiles. */
type WorkspaceFile = Awaited<ReturnType<ResearchWorkspaceService["listFiles"]>>[number];

/** md/txt (and any text/* mime) are readable as UTF-8 without conversion. */
function isPlainTextFile(name: string, mimeType: string | undefined): boolean {
  if (PLAIN_TEXT_EXTENSIONS.test(name ?? "")) return true;
  return typeof mimeType === "string" && /^text\//i.test(mimeType);
}

/** Flattens a parsed docx into one plain-text blob (title + headings + bodies). */
function docxPlainText(parsed: Awaited<ReturnType<typeof parseDocxSections>>): string {
  const parts: string[] = [];
  if (parsed.title?.trim()) parts.push(parsed.title.trim());
  for (const section of parsed.sections) {
    if (section.title.trim()) parts.push(section.title.trim());
    if (section.content.trim()) parts.push(section.content.trim());
  }
  return parts.join("\n\n");
}

export function createResearchWorkspaceTool(service: ResearchWorkspaceService) {
  return defineTool({
    name: "research_workspace",
    description:
      "学术研究空间与课题目录管理。action=create_space 创建学术空间；" +
      "action=ensure_project 为 project_id 创建课题目录树（00_课题与计划/01_文献/02_数据/03_代码与实验/04_结果/05_论文/06_投稿）；" +
      "action=list 查看已有空间；action=list_files 列出目录文件（需要 projectId + kind）；" +
      "action=read_file 读取项目文件文本（需要 projectId + name 或 uploadUuid；支持 docx/md/txt，最多返回 8000 字），可先读用户的 Word 模板再决定如何写作；" +
      "action=upload_text 上传文本到目录。云盘文件由 app-cloud 管理。",
    inputSchema: z.object({
      action: z.enum(["create_space", "ensure_project", "list", "upload_text", "list_files", "read_file"]),
      title: z.string().optional().describe("空间或课题标题"),
      projectId: z.string().optional().describe("academic_project 创建后得到的 project_id"),
      workspaceId: z.string().optional().describe("已有学术空间 id；省略时使用最近一个或自动创建"),
      kind: z.enum(["data", "code", "results", "manuscript", "literature", "plan", "submission"]).optional(),
      name: z.string().optional().describe("文件名（upload_text 上传名 / read_file 按名称查找）"),
      content: z.string().optional().describe("upload_text 的文本内容"),
      uploadUuid: z.string().min(1).max(200).optional().describe("read_file 按云盘文件 id 查找（与 name 二选一）"),
    }),
    async execute(args, ctx: ToolRunContext) {
      const uid = ctx.uid;
      if (!uid) return "当前会话没有用户身份，无法访问学术空间。";
      try {
        if (args.action === "list") {
          const workspaces = await service.list(uid);
          if (workspaces.length === 0) return "还没有学术研究空间。请先用 action=create_space 创建。";
          return workspaces
            .map(
              (w) =>
                "- " +
                w.workspaceId +
                " · " +
                w.title +
                "（课题 " +
                w.projects.length +
                " 个）" +
                w.projects.map((p) => "\n  - " + p.projectId + " · " + p.title).join(""),
            )
            .join("\n");
        }
        if (args.action === "list_files") {
          if (!args.projectId || !args.kind) return "缺少 projectId 或 kind。";
          const files = await service.listFiles(uid, args.projectId, args.kind);
          if (files.length === 0) return "该目录还没有文件。";
          return files
            .map((f) => "- " + f.upload_uuid + " · " + f.name + " · " + f.size + "B · " + f.mime_type)
            .join("\n");
        }
        if (args.action === "read_file") {
          if (!args.projectId) return "read_file 需要 projectId：请先用 academic_project(action=list) 确认项目。";
          const projectId = args.projectId;
          const wantedUuid = args.uploadUuid?.trim() ?? "";
          const wantedName = args.name?.trim() ?? "";
          if (!wantedUuid && !wantedName) {
            return "read_file 需要 name 或 uploadUuid：先用 action=list_files 查看项目云盘文件。";
          }
          // Locate the file across the seven project folders. One unreadable
          // folder must not block the read, so failures are skipped.
          let located: { kind: ResearchFolderKind; file: WorkspaceFile } | undefined;
          for (const kind of WORKSPACE_FOLDER_KINDS) {
            try {
              const files = await service.listFiles(uid, projectId, kind);
              const hit = wantedUuid
                ? files.find((file) => file.upload_uuid === wantedUuid)
                : (files.find((file) => file.name === wantedName) ??
                  files.find((file) => file.name.toLowerCase() === wantedName.toLowerCase()));
              if (hit) {
                located = { kind, file: hit };
                break;
              }
            } catch {
              continue;
            }
          }
          if (!located) {
            return (
              "项目云盘里没有找到文件「" +
              (wantedName || wantedUuid) +
              "」。可先用 action=list_files 查看各目录文件与 upload_uuid。"
            );
          }
          const file = located.file;
          let downloaded: { contentType: string; data: Uint8Array };
          try {
            downloaded = await service.downloadFile(uid, file.upload_uuid);
          } catch (err) {
            return "读取文件失败：" + (err instanceof Error ? err.message : String(err));
          }
          const meta =
            "文件：" +
            file.name +
            "（目录 " +
            located.kind +
            "，" +
            file.size +
            " B，" +
            (file.mime_type || "未知类型") +
            "，upload_uuid=" +
            file.upload_uuid +
            "）";
          let text: string;
          if (isDocxFile(file.name, file.mime_type)) {
            try {
              text = docxPlainText(await parseDocxSections(downloaded.data));
            } catch (err) {
              return meta + "\nWord 解析失败：" + (err instanceof Error ? err.message : String(err));
            }
          } else if (isPlainTextFile(file.name, file.mime_type)) {
            text = new TextDecoder("utf-8").decode(downloaded.data).replace(/^\uFEFF/, "");
          } else {
            return (
              meta +
              "\n该文件类型暂不支持文本读取（支持 docx/md/txt）。可用 action=list_files 查看元信息，或让用户在写作页下载后查看。"
            );
          }
          const total = text.length;
          const clipped =
            total > MAX_READ_CHARS
              ? text.slice(0, MAX_READ_CHARS) +
                "\n\n…（已截断：全文 " +
                total +
                " 字，仅显示前 " +
                MAX_READ_CHARS +
                " 字）"
              : text;
          return meta + "\n\n" + (clipped.trim().length > 0 ? clipped : "（文件没有可提取的文本）");
        }
        if (args.action === "upload_text") {
          if (!args.projectId || !args.kind || !args.name || args.content === undefined) {
            return "upload_text 需要 projectId、kind、name、content。";
          }
          const result = await service.uploadFile(
            uid,
            args.projectId,
            args.kind,
            args.name ?? "artifact.txt",
            new TextEncoder().encode(args.content),
            "text/plain; charset=utf-8",
          );
          return (
            "已上传到课题目录。\nupload_uuid=" +
            result.upload_uuid +
            "\nfolder_id=" +
            result.folderId +
            "\nsha256=" +
            (result.sha256 ?? "")
          );
        }
        if (args.action === "create_space") {
          const title = args.title?.trim() || "学术研究";
          const workspace = await service.createWorkspace(uid, title);
          return (
            "已创建学术研究空间。\nworkspace_id=" +
            workspace.workspaceId +
            "\n云盘根目录 folder_id=" +
            workspace.rootFolderId
          );
        }
        if (!args.projectId) return "缺少 projectId：请先用 academic_project(action=create) 创建课题。";
        const workspace = await service.ensureProject(
          uid,
          args.projectId,
          args.title?.trim() || args.projectId,
          args.workspaceId,
        );
        const project = workspace.projects.find((p) => p.projectId === args.projectId);
        if (!project) return "课题目录创建失败。";
        return (
          "课题目录已就绪。\nworkspace_id=" +
          workspace.workspaceId +
          "\nproject_id=" +
          project.projectId +
          "\n目录：\n" +
          Object.entries(project.folders)
            .map(([key, id]) => "- " + key + ": folder_id=" + id)
            .join("\n")
        );
      } catch (err) {
        return "学术空间操作失败：" + (err instanceof Error ? err.message : String(err));
      }
    },
  });
}
