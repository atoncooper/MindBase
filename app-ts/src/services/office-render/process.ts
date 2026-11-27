import { spawn } from "node:child_process";

/**
 * Command runner port for the Office renderer.
 *
 * The renderer shells out to soffice/pdftoppm. Both are optional in a deployment
 * (the image only carries LibreOffice when built with the renderer flag), so the
 * spawn call is isolated behind this two-method port: tests drive the whole
 * render pipeline with a fake runner (no binaries, no network, no temp juggling)
 * and the production implementation stays a thin, timeout-guarded spawn.
 */

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

/** Spawns a real process; stdout/stderr are capped so a chatty tool cannot balloon memory. */
export class NodeCommandRunner implements CommandRunner {
  private readonly maxOutputChars = 20_000;

  async run(request: CommandRequest): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: { ...process.env, ...(request.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeoutMs);
      const append = (current: string, chunk: Buffer) => {
        const next = current + chunk.toString("utf8");
        return next.length > this.maxOutputChars ? next.slice(0, this.maxOutputChars) : next;
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: stderr + " | " + (err.message ?? String(err)), timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });
  }
}
