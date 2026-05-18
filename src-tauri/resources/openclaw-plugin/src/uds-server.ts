// src/uds-server.ts
import { chmodSync, unlinkSync, existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { unwrapFromWire } from "./auth.js";
import { LineSplitter, type Frame } from "./protocol.js";

export interface UdsServerOpts {
  socketPath: string;
  accessToken: string;
  onFrame: (f: Frame) => void;
  onClientConnect: () => void;
  onClientDisconnect: () => void;
}

export class UdsServer {
  private server: Server | null = null;
  private current: Socket | null = null;
  private splitter = new LineSplitter();

  constructor(private opts: UdsServerOpts) {}

  async start(): Promise<void> {
    if (existsSync(this.opts.socketPath)) {
      try {
        unlinkSync(this.opts.socketPath);
      } catch {
        /* race-tolerant */
      }
    }
    this.server = createServer((sock) => this.onConnect(sock));
    await new Promise<void>((res, rej) => {
      this.server!.once("error", rej);
      this.server!.listen(this.opts.socketPath, () => {
        try {
          chmodSync(this.opts.socketPath, 0o600);
          res();
        } catch (e) {
          rej(e);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.current) this.current.destroy();
    if (this.server) {
      await new Promise<void>((res) => this.server!.close(() => res()));
      this.server = null;
    }
    if (existsSync(this.opts.socketPath)) {
      try {
        unlinkSync(this.opts.socketPath);
      } catch {
        /* ignore */
      }
    }
  }

  sendWrappedLine(line: string): void {
    if (!this.current) return;
    this.current.write(line + "\n");
  }

  private onConnect(sock: Socket): void {
    if (this.current) {
      sock.destroy();
      return;
    }
    this.current = sock;
    this.splitter = new LineSplitter();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.splitter.push(chunk, (line) => {
        try {
          const frame = unwrapFromWire(line, this.opts.accessToken);
          this.opts.onFrame(frame);
        } catch {
          // bad frame: ignore, log nothing (caller wires logging)
        }
      });
    });
    sock.once("close", () => {
      if (this.current === sock) this.current = null;
      this.opts.onClientDisconnect();
    });
    this.opts.onClientConnect();
  }

  hasClient(): boolean {
    return this.current !== null;
  }
}
