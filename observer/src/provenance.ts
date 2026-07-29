import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Provenance } from "./types.js";

const EXPECTED_ARCHIVE =
  "a970ea9f9cf477e9380ca17b8f218d770e5f9866a807815ce4fb7799ced6974c";
const EXPECTED_SOURCE =
  "21c9137399f51c1205a269b5e24b48a67b89eb0bb2745d792d70b362ffc685d2";
const SKIP = new Set(["node_modules", "dist", ".lake", ".git", "data"]);

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function immutableSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(path);
      } else {
        files.push(path);
      }
    }
  };
  walk(root);
  return files.sort();
}

function hashSource(root: string): string {
  const hash = createHash("sha256");
  for (const path of immutableSourceFiles(root)) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function buildProvenance(agentRoot: string, archive: string): Provenance {
  const archiveSha256 = hashFile(archive);
  const sourceSha256 = hashSource(agentRoot);
  return {
    projectId: "5999f818-6116-43e6-8a4e-af4e0b5c35c8",
    taskId: "cf26e10a-a7d1-41be-a1db-9c3eed226b85",
    archiveSha256,
    sourceSha256,
    sourceUnmodified:
      archiveSha256 === EXPECTED_ARCHIVE && sourceSha256 === EXPECTED_SOURCE,
    checkedAt: new Date().toISOString()
  };
}

export function hashProof(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}
