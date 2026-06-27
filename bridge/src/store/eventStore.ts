// In-memory append-only event feed (ring buffer). Mirrors a hook-based observability
// model: one-way report events (SubagentStop / Notification / PostToolUse / Decision /
// ApprovalRequest). Messages are already redacted one-liners (see redact.ts) — never tool input.

import { randomUUID } from "node:crypto";
import type { EventKind, EventSeverity, EventView } from "../contracts/index.js";

export interface AppendInput {
  kind: EventKind;
  message: string; // REDACTED one-liner
  severity?: EventSeverity;
  source?: string;
}

export class EventStore {
  private readonly buffer: EventView[] = [];
  private readonly max: number;

  constructor(opts: { max: number }) {
    this.max = opts.max;
  }

  append(input: AppendInput): EventView {
    const event: EventView = {
      id: randomUUID(),
      kind: input.kind,
      message: input.message,
      severity: input.severity ?? "info",
      createdAt: new Date().toISOString()
    };
    if (input.source !== undefined) event.source = input.source;
    this.buffer.push(event);
    if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max);
    return event;
  }

  // Most-recent-first.
  list(): EventView[] {
    return [...this.buffer].reverse();
  }
}
