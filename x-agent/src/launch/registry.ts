import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LaunchRecord, LaunchRegistryData } from "./types.js";

const EMPTY: LaunchRegistryData = { version: 1, records: [] };

export class LaunchRegistry {
  constructor(private readonly file: string) {}

  async read(): Promise<LaunchRegistryData> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<LaunchRegistryData>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error("Unsupported launch registry format.");
      return { version: 1, records: parsed.records };
    } catch (error) {
      if (isMissing(error)) return structuredClone(EMPTY);
      throw error;
    }
  }

  async save(data: LaunchRegistryData): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o750 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o640 });
    await rename(temporary, this.file);
  }

  async insert(record: LaunchRecord): Promise<void> {
    const data = await this.read();
    data.records.push(record);
    await this.save(data);
  }

  async update(id: string, patch: Partial<LaunchRecord>): Promise<LaunchRecord> {
    const data = await this.read();
    const index = data.records.findIndex((record) => record.id === id);
    if (index < 0) throw new Error(`Launch record not found: ${id}`);
    const updated = { ...data.records[index], ...patch, updatedAt: new Date().toISOString() };
    data.records[index] = updated;
    await this.save(data);
    return updated;
  }

  async recentForAuthor(authorId: string, sinceMs: number): Promise<LaunchRecord | undefined> {
    const data = await this.read();
    return data.records
      .filter((record) => record.authorId === authorId)
      .filter((record) => Date.parse(record.createdAt) >= sinceMs)
      .filter((record) => record.stage !== "failed_before_funding")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  async countRecent(sinceMs: number): Promise<number> {
    const data = await this.read();
    return data.records
      .filter((record) => Date.parse(record.createdAt) >= sinceMs)
      .filter((record) => record.stage !== "failed_before_funding")
      .length;
  }

  async findByTweetId(tweetId: string): Promise<LaunchRecord | undefined> {
    return (await this.read()).records.find((record) => record.requestTweetId === tweetId);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
