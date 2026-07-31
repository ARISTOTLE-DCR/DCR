import { mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const STALE_MS = 5 * 60_000;

export async function withNonceLock<T>(address: string, task: () => Promise<T>): Promise<T> {
  const root = process.env.TRANSACTION_LOCK_DIR;
  if (!root) return task();
  await mkdir(root, { recursive: true, mode: 0o2770 });
  const file = join(root, `${address.toLowerCase().replace(/^0x/, "")}.lock`);

  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o640);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
        return await task();
      } finally {
        await handle.close();
        await unlink(file).catch(() => undefined);
      }
    } catch (error) {
      if (!isExists(error)) throw error;
      try {
        if (Date.now() - (await stat(file)).mtimeMs > STALE_MS) {
          await unlink(file);
          continue;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for the shared signer nonce lock.");
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
