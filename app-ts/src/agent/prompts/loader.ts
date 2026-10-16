import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { config } from "../../config/index.js";

/**
 * PromptRegistry: system prompts live as Markdown files under prompts/ in
 * domain subdirectories (agents/ quiz/ chat/ kg/ …), loaded once at startup.
 * Prompt name = relative path from the prompts dir without the .md extension
 * (posix separators), e.g. "agents/main", "quiz/styles/gaokao",
 * "quiz/batch-user" — the folder IS the namespace, so growing prompt counts
 * stay organized. Dynamic content is injected via {{PLACEHOLDER}} substitution
 * at render time; rendering fails fast if a placeholder is left unfilled
 * (catches prompt drift early).
 */
export class PromptRegistry {
  private readonly prompts = new Map<string, string>();

  private constructor() {}

  /** Recursively load *.md files in dir. Throws if the dir is missing or empty (prompts are essential). */
  static load(dir: string = resolve(config.prompts.dir)): PromptRegistry {
    const registry = new PromptRegistry();
    const files: string[] = [];
    const walk = (d: string) => {
      let entries: string[];
      try {
        entries = readdirSync(d);
      } catch (err) {
        throw new Error(
          `[PROMPTS] cannot read prompts dir "${d}": ${err instanceof Error ? err.message : err}`,
        );
      }
      for (const entry of entries) {
        const full = join(d, entry);
        let isDir = false;
        try { isDir = readdirSync(full) !== undefined; } catch { isDir = false; }
        if (isDir) walk(full);
        else if (entry.endsWith(".md")) files.push(full);
      }
    };
    try {
      walk(dir);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (files.length === 0) {
      throw new Error(`[PROMPTS] no .md prompt files found in "${dir}"`);
    }
    for (const file of files) {
      const rel = relative(dir, file).split(/\\|\//).join("/");
      const name = rel.replace(/\.md$/, "");
      if (registry.prompts.has(name)) {
        throw new Error(`[PROMPTS] duplicate prompt name "${name}" (${file})`);
      }
      registry.prompts.set(name, readFileSync(file, "utf-8"));
    }
    return registry;
  }

  names(): string[] {
    return [...this.prompts.keys()].sort();
  }

  has(name: string): boolean {
    return this.prompts.has(name);
  }

  get(name: string): string {
    const tpl = this.prompts.get(name);
    if (tpl === undefined) {
      throw new Error(`[PROMPTS] prompt "${name}" not found (have: ${this.names().join(", ")})`);
    }
    return tpl;
  }

  /** Substitute {{KEY}} placeholders. Throws if the template has placeholders not provided in vars. */
  render(name: string, vars: Record<string, string>): string {
    const tpl = this.get(name);
    const required = [...tpl.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    const missing = [...new Set(required)].filter((k) => !(k in vars));
    if (missing.length > 0) {
      throw new Error(`[PROMPTS] prompt "${name}" is missing vars: ${missing.join(", ")}`);
    }
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k]);
  }
}
