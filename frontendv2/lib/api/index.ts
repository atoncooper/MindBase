/**
 * API barrel - single import surface for the whole backend client.
 *
 * Usage: `import { chatApi, authApi, type UserInfo } from "@/lib/api"`.
 *
 * Each feature domain lives in its own file under this directory; this file
 * only re-exports them so consumers see one flat module, matching the old
 * single-file `lib/api.ts` public API.
 */

// Shared infra
export { API_BASE_URL } from "./client";

// Feature domains
export * from "./auth";
export * from "./favorites";
export * from "./knowledge";
export * from "./chat";
export * from "./session-summary";
export * from "./code-executions";
export * from "./vec-page";
export * from "./asr";
export * from "./embedding-config";
export * from "./asr-config";
export * from "./settings";
export * from "./credentials";
export * from "./billing";
export * from "./quiz";
export * from "./task-quiz";
export * from "./user";
export * from "./tasks";
export * from "./cloud";
export * from "./workspace";
export * from "./notes";
export * from "./skills";
export * from "./preferences";
