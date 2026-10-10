import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../../config/index.js";

/**
 * PromptRegistry: system prompts live as Markdown files (prompts/*.md),
 * loaded once at startup into memory. Filename stem = prompt name.
 * Dynamic content is injected via {{PLACEHOLDER}} substitution at render time;
 * rendering fails fast if a placeholder is left unfilled (catches prompt drift early).
 */
export class PromptRegistry {
  private readonly prompts = new Map<string, string>();

  private constructor() {}

  /** Load all *.md files in dir. Throws if the dir is missing or empty (prompts are essential). */
  static load(dir: string = resolve(config.prompts.dir)): PromptRegistry {
    const registry = new PromptRegistry();
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch (err) {
      throw new Error(
        `[PROMPTS] cannot read prompts dir "${dir}": ${err instanceof Error ? err.message : err}`,
      );
    }
    if (files.length === 0) {
      throw new Error(`[PROMPTS] no .md prompt files found in "${dir}"`);
    }
    for (const file of files) {
      const name = file.replace(/\.md$/, "");
      registry.prompts.set(name, readFileSync(join(dir, file), "utf-8"));
    }
    return registry;
  }

  names(): string[] {
    return [...this.prompts.keys()];
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
