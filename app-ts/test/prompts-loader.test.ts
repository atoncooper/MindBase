import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptRegistry } from "../src/agent/prompts/loader.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "prompts-"));
  // 命名空间结构：agents/ 与 quiz/styles/ 子目录（目录即分类）
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "quiz", "styles"), { recursive: true });
  writeFileSync(join(dir, "agents", "greet.md"), "Hello {{NAME}}, today is {{DAY}}.");
  writeFileSync(join(dir, "agents", "static.md"), "No placeholders here.");
  writeFileSync(join(dir, "quiz", "styles", "gaokao.md"), "高考风格。");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PromptRegistry", () => {
  it("loads *.md recursively, relative path = prompt name", () => {
    const r = PromptRegistry.load(dir);
    expect(r.names().sort()).toEqual(["agents/greet", "agents/static", "quiz/styles/gaokao"]);
    expect(r.has("agents/greet")).toBe(true);
    expect(r.has("quiz/styles/gaokao")).toBe(true);
  });

  it("render substitutes all placeholders", () => {
    const r = PromptRegistry.load(dir);
    expect(r.render("agents/greet", { NAME: "MindBase", DAY: "Monday" })).toBe(
      "Hello MindBase, today is Monday.",
    );
  });

  it("render throws on unfilled placeholders (fail fast)", () => {
    const r = PromptRegistry.load(dir);
    expect(() => r.render("agents/greet", { NAME: "x" })).toThrow(/missing vars: DAY/);
  });

  it("static template renders with empty vars", () => {
    const r = PromptRegistry.load(dir);
    expect(r.render("agents/static", {})).toBe("No placeholders here.");
  });

  it("get throws on unknown prompt", () => {
    const r = PromptRegistry.load(dir);
    expect(() => r.get("nope")).toThrow(/not found/);
  });

  it("load throws on missing dir", () => {
    expect(() => PromptRegistry.load(join(dir, "not-exist"))).toThrow(/cannot read prompts dir/);
  });

  it("integration: real prompts dir has all namespaced agent + domain prompts", () => {
    const r = PromptRegistry.load();
    for (const name of [
      "agents/main", "agents/note", "agents/code", "agents/quiz", "agents/board", "agents/router",
      "agents/summary", "agents/title", "chat/compress", "kg/extract", "quiz/task-generation",
      "quiz/batch-system", "quiz/styles/gaokao",
    ]) {
      expect(r.has(name)).toBe(true);
    }
    // agents/main placeholders match what the agent factory provides
    const rendered = r.render("agents/main", {
      TODAY: "2026-10-03",
      KNOWLEDGE_STATUS: "可用",
      SCOPE_LINE: "检索范围：全部知识库",
      CONVERSATION_SECTION: "",
      SESSION_DOCS_SECTION: "",
      MEMORY_SECTION: "",
      KG_SEARCH_SECTION: "", // injected only when the KG capability is wired
      SKILLS_SECTION: "", // injected only when the skills subsystem is wired
    });
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
    // chat/compress 是静态模板（无占位符）
    expect(r.render("chat/compress", {})).toContain("压缩");
  });
});
