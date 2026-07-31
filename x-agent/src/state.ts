import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type BotState = {
  sinceId?: string;
  processedIds: string[];
};

const MAX_PROCESSED_IDS = 1000;

export async function loadState(filePath: string): Promise<BotState> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BotState>;
    return {
      sinceId: typeof parsed.sinceId === "string" ? parsed.sinceId : undefined,
      processedIds: Array.isArray(parsed.processedIds) ? parsed.processedIds.filter((id): id is string => typeof id === "string") : []
    };
  } catch (error) {
    if (isMissingFile(error)) return { processedIds: [] };
    throw error;
  }
}

export async function saveState(filePath: string, state: BotState): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function hasProcessed(state: BotState, tweetId: string): boolean {
  return state.processedIds.includes(tweetId);
}

export function markProcessed(state: BotState, tweetId: string): void {
  if (!state.processedIds.includes(tweetId)) state.processedIds.push(tweetId);
  if (state.processedIds.length > MAX_PROCESSED_IDS) {
    state.processedIds.splice(0, state.processedIds.length - MAX_PROCESSED_IDS);
  }
}

export function maxSnowflake(ids: Array<string | undefined>): string | undefined {
  return ids.filter((id): id is string => Boolean(id)).reduce<string | undefined>((max, id) => (!max || compareSnowflakes(id, max) > 0 ? id : max), undefined);
}

export function compareSnowflakes(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
