/**
 * Prism global mount. Import order matters, and ESM imports are hoisted, so
 * the sequence lives across two modules:
 *
 * 1. "./prism-manual" executes first and pre-seeds globalThis.Prism with
 *    `manual: true` (disables prism's DOMContentLoaded auto-highlightAll).
 * 2. "prismjs" core evaluates and reads that flag.
 * 3. This module's body replaces the global with the real Prism instance,
 *    which prismjs language components (components/prism-*) resolve at their
 *    own import time. So a registry module must import THIS module before any
 *    "prismjs/components/prism-xxx":
 *
 *      import Prism from "./prism-mount";
 *      import "prismjs/components/prism-xxx";
 *
 * (Same pattern as components/mindmap/editor/prismSetup.ts.)
 */
import "./prism-manual";
import Prism from "prismjs";

(globalThis as { Prism?: unknown }).Prism = Prism;

export default Prism;
