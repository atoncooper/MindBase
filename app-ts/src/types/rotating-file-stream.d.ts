/**
 * Local TypeScript declarations for `rotating-file-stream` (v4).
 *
 * The package is ESM/CJS with runtime code only; no `@types/rotating-file-stream`
 * exists and we do not want a blanket `any` on the logger sink. This ambient
 * module documents the small surface app-ts uses: `createStream` with
 * size/interval rotation, gzip compression, retention and history options.
 *
 * Keep it in sync with the options passed from `src/logger.ts`.
 */
declare module "rotating-file-stream" {
  import type { Writable } from "node:stream";

  export interface RotatingFileStreamOptions {
    /** Directory that the live/rotated files are written into. */
    path?: string;
    /** Rotate when the live file reaches this size (e.g. "20M"). */
    size?: string;
    /** Rotate on a time interval (e.g. "1d", "12h", "30m"). */
    interval?: string;
    /** Compress rotated files: false / true / "gzip". */
    compress?: boolean | "gzip";
    /** Number of rotated files to keep; older ones are deleted. */
    maxFiles?: number;
    /** Optional history file (relative to `path`) tracking rotated files. */
    history?: string;
    /** Immutable mode: never move the live file, start a new numbered one. */
    immutable?: boolean;
  }

  /** Writable stream that rotates/compresses its target file. */
  export interface RotatingFileStream extends Writable {
    end(cb?: () => void): this;
  }

  export function createStream(
    filename: string | ((index: number | null) => string),
    options?: RotatingFileStreamOptions,
  ): RotatingFileStream;

  /** Error raised for library-originated failures (invalid options, I/O). */
  export class RotatingFileStreamError extends Error {}
}
