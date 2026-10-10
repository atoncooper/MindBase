import type { ToolDefinition } from "./base.js";

/**
 * ToolRegistry: name → tool definition. The LLM only sees name/description/inputSchema.
 * Python's @register_tool auto-discovery (pkgutil scan) is simplified to explicit registration in v1 —
 * with few tools, explicit registration is more auditable; add hot-loading scans later if needed.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[REGISTRY] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
