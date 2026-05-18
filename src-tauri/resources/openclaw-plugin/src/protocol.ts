export type FrameType =
  // host -> plugin
  | "hello"
  | "user.message"
  | "user.cancel"
  | "user.attach.upload"
  | "user.request_file"
  | "user.push_file"
  // plugin -> host
  | "welcome"
  | "agent.message.delta"
  | "agent.message.end"
  | "agent.attachment"
  | "agent.tool_call"
  | "agent.file_content"
  // bidirectional session management
  | "session.list"
  | "session.list.result"
  | "session.new"
  | "session.open"
  | "session.replay"
  | "error";

export interface BaseFrame {
  v: 1;
  type: FrameType;
}

export type Frame = BaseFrame & Record<string, unknown>;

export function encodeFrame(f: Frame): string {
  return JSON.stringify(f) + "\n";
}

export function decodeFrameLine(line: string): Frame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    throw new Error("frame parse error: " + (e as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("frame parse error: not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) {
    throw new Error("frame protocol version mismatch: expected v=1, got " + JSON.stringify(obj.v));
  }
  if (typeof obj.type !== "string") {
    throw new Error("frame missing type");
  }
  return obj as Frame;
}

export class LineSplitter {
  private buf = "";
  push(chunk: string, onLine: (line: string) => void): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
  }
}
