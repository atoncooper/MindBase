import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptRegistry } from "../src/agent/prompts/loader.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "prompts-"));
  writeFileSync(join(dir, "greet.md"), "Hello {{NAME}}, today is {{DAY}}.");
  writeFileSync(join(dir, "static.md"), "No placeholders here.");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PromptRegistry", () => {
  it("loads all .md files, filename stem = prompt name", () => {
    const r = PromptRegistry.load(dir);
    expect(r.names().sort()).toEqual(["greet", "static"]);
    expect(r.has("greet")).toBe(true);
  });

  it("render substitutes all placeholders", () => {
    const r = PromptRegistry.load(dir);
    expect(r.render("greet", { NAME: "MindBase", DAY: "Monday" })).toBe(
      "Hello MindBase, today is Monday.",
    );
  });

  it("render throws on unfilled placeholders (fail fast)", () => {
    const r = PromptRegistry.load(dir);
    expect(() => r.render("greet", { NAME: "x" })).toThrow(/missing vars: DAY/);
  });

  it("static template renders with empty vars", () => {
    const r = PromptRegistry.load(dir);
    expect(r.render("static", {})).toBe("No placeholders here.");
  });

  it("get throws on unknown prompt", () => {
    const r = PromptRegistry.load(dir);
    expect(() => r.get("nope")).toThrow(/not found/);
  });

  it("load throws on missing dir", () => {
    expect(() => PromptRegistry.load(join(dir, "not-exist"))).toThrow(/cannot read prompts dir/);
  });

  it("integration: real prompts dir has all agent + router prompts", () => {
    const r = PromptRegistry.load();
    for (const name of ["main", "note", "code", "quiz", "board", "router"]) {
      expect(r.has(name)).toBe(true);
    }
    // main.md placeholders match what the agent factory provides
    const rendered = r.render("main", {
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
    // compress.md is a static template (no placeholders)
    expect(r.render("compress", {})).toContain("压缩");
  });
});
