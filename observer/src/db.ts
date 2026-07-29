import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import type { Activity, Provenance, Snapshot } from "./types.js";

interface AgentEvent {
  timestamp: string;
  eventType: string;
  payload: unknown;
}

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

export class Store {
  private readonly snapshotFile: string;
  private readonly activityFile: string;
  private readonly agentEventFile: string;
  private readonly metaFile: string;
  private readonly proofHashes = new Set<string>();
  private readonly activityKeys = new Set<string>();
  private meta: Record<string, string>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.snapshotFile = join(dataDir, "snapshots.jsonl");
    this.activityFile = join(dataDir, "activity.jsonl");
    this.agentEventFile = join(dataDir, "agent-events.jsonl");
    this.metaFile = join(dataDir, "meta.json");
    this.meta = this.loadMeta();
    for (const snapshot of readJsonLines<Snapshot>(this.snapshotFile)) {
      this.proofHashes.add(snapshot.proofHash);
    }
    for (const activity of readJsonLines<Activity>(this.activityFile)) {
      if (activity.txHash) {
        this.activityKeys.add(`${activity.kind}:${activity.txHash}`);
      }
    }
  }

  saveSnapshot(snapshot: Snapshot): void {
    if (this.proofHashes.has(snapshot.proofHash)) return;
    appendJsonLine(this.snapshotFile, snapshot);
    this.proofHashes.add(snapshot.proofHash);
  }

  latestSnapshot(): Snapshot | null {
    return readJsonLines<Snapshot>(this.snapshotFile).at(-1) ?? null;
  }

  snapshots(limit = 180): Snapshot[] {
    return readJsonLines<Snapshot>(this.snapshotFile)
      .slice(-Math.min(Math.max(limit, 1), 1_000));
  }

  saveActivity(activity: Activity): void {
    const key = activity.txHash ? `${activity.kind}:${activity.txHash}` : null;
    if (key && this.activityKeys.has(key)) return;
    appendJsonLine(this.activityFile, activity);
    if (key) this.activityKeys.add(key);
  }

  activities(limit = 100): Activity[] {
    return readJsonLines<Activity>(this.activityFile)
      .slice(-Math.min(Math.max(limit, 1), 500))
      .reverse();
  }

  saveAgentEvent(eventType: string, payload: unknown): void {
    appendJsonLine(this.agentEventFile, {
      timestamp: new Date().toISOString(),
      eventType,
      payload
    } satisfies AgentEvent);
  }

  agentEvents(limit = 100): AgentEvent[] {
    return readJsonLines<AgentEvent>(this.agentEventFile)
      .slice(-Math.min(Math.max(limit, 1), 500))
      .reverse();
  }

  setMeta(key: string, value: string): void {
    this.meta[key] = value;
    const temporary = `${this.metaFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.meta, null, 2), "utf8");
    renameSync(temporary, this.metaFile);
  }

  getMeta(key: string): string | null {
    return this.meta[key] ?? null;
  }

  setProvenance(provenance: Provenance): void {
    this.setMeta("provenance", JSON.stringify(provenance));
  }

  provenance(): Provenance | null {
    const value = this.getMeta("provenance");
    return value ? JSON.parse(value) as Provenance : null;
  }

  private loadMeta(): Record<string, string> {
    if (!existsSync(this.metaFile)) return {};
    try {
      return JSON.parse(readFileSync(this.metaFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }
}
