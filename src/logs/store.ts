import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { redactJson } from "./redact.js";
import { getDataDir } from "../paths.js";
export type LogDirection = "ingress" | "egress";

export interface LogRecord {
  id: string;
  requestId: string;
  direction: LogDirection;
  ts: string;
  method: string;
  path: string;
  model?: string | null;
  provider?: string | null;
  status?: number | null;
  latencyMs?: number | null;
  stream?: boolean | null;
  sizeBytes?: number | null;
  error?: string | null;
  tags?: string[];
  request?: unknown;
  response?: unknown;
  meta?: Record<string, unknown>;
}

export interface LogState {
  enabled: boolean;
  paused: boolean;
  dropped: number;
  size: number;
  capacity: number;
}

interface LogStateUpdate {
  enabled?: boolean;
  paused?: boolean;
  capacity?: number;
}

export interface LogQuery {
  direction?: LogDirection | "all";
  search?: string | null;
  limit?: number;
  offset?: number;
}

const DEFAULT_CAPACITY = 2000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset));
}

export class LogStore {
  private records: LogRecord[] = [];
  private capacity: number;
  private enabled = true;
  private paused = false;
  private dropped = 0;
  private queue: LogRecord[] = [];
  private flushScheduled = false;
  private logFilePath: string | null = null;
  private maxFileSize = 50 * 1024 * 1024; // 50 MB

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  async init(): Promise<void> {
    this.logFilePath = path.join(getDataDir(), "logs.jsonl");
    if (!fs.existsSync(this.logFilePath)) return;

    try {
      const fileStream = fs.createReadStream(this.logFilePath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      const loaded: LogRecord[] = [];
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          loaded.push(JSON.parse(line));
        } catch { /* skip corrupted lines */ }
      }
      
      // Keep only the most recent 'capacity' logs
      if (loaded.length > this.capacity) {
        this.records = loaded.slice(loaded.length - this.capacity);
      } else {
        this.records = loaded;
      }
    } catch (err) {
      console.error("[LogStore] Failed to load persistent logs", err);
    }
  }

  getState(): LogState {
    return {
      enabled: this.enabled,
      paused: this.paused,
      dropped: this.dropped,
      size: this.records.length,
      capacity: this.capacity,
    };
  }

  setState(next: LogStateUpdate): LogState {
    if (typeof next.enabled === "boolean") {
      this.enabled = next.enabled;
      if (next.enabled) this.paused = false;
    }
    if (typeof next.paused === "boolean") this.paused = next.paused;
    if (typeof next.capacity === "number" && Number.isFinite(next.capacity)) {
      this.capacity = Math.max(1, Math.trunc(next.capacity));
      this.trimToCapacity();
    }
    return this.getState();
  }

  clear(): void {
    this.records = [];
    this.dropped = 0;
  }

  enqueue(record: LogRecord): void {
    if (!this.enabled || this.paused) return;
    this.queue.push(record);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  list(query: LogQuery): { records: LogRecord[]; total: number; offset: number; limit: number } {
    const direction = query.direction ?? "all";
    const search = (query.search ?? "").trim().toLowerCase();
    let results = this.records;

    if (direction !== "all") {
      results = results.filter((r) => r.direction === direction);
    }

    if (search) {
      results = results.filter((r) => {
        const hay = `${r.method} ${r.path} ${r.model ?? ""} ${r.provider ?? ""} ${r.status ?? ""}`.toLowerCase();
        return hay.includes(search);
      });
    }

    const total = results.length;
    const limit = normalizeLimit(query.limit);
    const offset = normalizeOffset(query.offset);
    const newestFirst = [...results].reverse();
    const sliced = newestFirst.slice(offset, offset + limit);

    return { records: sliced, total, offset, limit };
  }

  get(id: string): LogRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  private flush(): void {
    this.flushScheduled = false;
    if (!this.queue.length) return;

    const batch = this.queue.splice(0, this.queue.length);
    const linesToAppend: string[] = [];

    for (const record of batch) {
      const redacted: LogRecord = {
        ...record,
        request: record.request !== undefined ? redactJson(record.request) : undefined,
        response: record.response !== undefined ? redactJson(record.response) : undefined,
      };
      this.records.push(redacted);
      linesToAppend.push(JSON.stringify(redacted));
    }

    if (this.logFilePath && linesToAppend.length > 0) {
      try {
        fs.appendFileSync(this.logFilePath, linesToAppend.join("\n") + "\n", "utf8");
        // Simple rotation check
        const stats = fs.statSync(this.logFilePath);
        if (stats.size > this.maxFileSize) {
          const oldPath = this.logFilePath + ".old";
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
          fs.renameSync(this.logFilePath, oldPath);
          // Write current memory cache back to the new file
          fs.writeFileSync(this.logFilePath, this.records.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
        }
      } catch (err) {
        console.error("[LogStore] Failed to write logs to disk", err);
      }
    }

    this.trimToCapacity();
  }

  private trimToCapacity(): void {
    if (this.records.length <= this.capacity) return;
    const over = this.records.length - this.capacity;
    this.records.splice(0, over);
    this.dropped += over;
  }
}

export const logStore = new LogStore();
