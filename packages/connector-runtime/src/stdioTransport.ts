import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { ConnectorError } from "./model.js";

export class ProcessGroupStdioTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private lifecycle: "new" | "running" | "closed" = "new";
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private readonly buffer: ReadBuffer;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  constructor(private readonly options: { command: string; arguments: string[]; cwd: string; environment: Record<string, string>; maxOutputBytes: number }) {
    if (process.platform === "win32") throw new ConnectorError("connection_unavailable");
    this.buffer = new ReadBuffer({ maxBufferSize: options.maxOutputBytes });
  }
  get pid(): number | null { return this.child?.pid ?? null; }
  get stderr(): ChildProcessWithoutNullStreams["stderr"] | null { return this.child?.stderr ?? null; }
  start(): Promise<void> {
    if (this.lifecycle !== "new") return Promise.reject(new ConnectorError("transport_failed"));
    this.lifecycle = "running";
    const child = spawn(this.options.command, this.options.arguments, { cwd: this.options.cwd, env: this.options.environment, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.exited = new Promise(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.lifecycle !== "running") return;
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > this.options.maxOutputBytes) { this.fail(new ConnectorError("output_limit")); return; }
      try {
        this.buffer.append(chunk);
        let message = this.buffer.readMessage();
        while (message !== null) { this.onmessage?.(message); message = this.buffer.readMessage(); }
      } catch { this.fail(new ConnectorError("transport_failed")); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > this.options.maxOutputBytes) this.fail(new ConnectorError("output_limit"));
    });
    child.stdin.on("error", () => this.fail(new ConnectorError("transport_failed")));
    child.stdout.on("error", () => this.fail(new ConnectorError("transport_failed")));
    child.stderr.on("error", () => this.fail(new ConnectorError("transport_failed")));
    child.once("exit", () => { void this.close().catch(() => undefined); });
    return new Promise((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", () => { const error = new ConnectorError("transport_failed"); this.fail(error); reject(error); });
    });
  }
  private fail(error: ConnectorError): void {
    if (this.lifecycle === "closed") return;
    this.onerror?.(error);
    void this.close().catch(() => undefined);
  }
  private killGroup(child: ChildProcessWithoutNullStreams): void {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw new ConnectorError("transport_failed"); }
  }
  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.lifecycle = "closed";
    const child = this.child;
    this.child = null;
    this.closing = this.teardown(child).finally(() => { this.buffer.clear(); this.onclose?.(); });
    return this.closing;
  }
  private async teardown(child: ChildProcessWithoutNullStreams | null): Promise<void> {
    if (child === null) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      this.killGroup(child);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      await Promise.race([this.exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new ConnectorError("transport_failed")), 2_000); })]);
      this.killGroup(child);
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
  send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (this.lifecycle !== "running" || child === null) return Promise.reject(new ConnectorError("transport_failed"));
    return new Promise((resolve, reject) => { child.stdin.write(serializeMessage(message), error => { if (error) reject(new ConnectorError("transport_failed")); else resolve(); }); });
  }
}
