import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Provenance } from "./types.js";

const EXPECTED_ARCHIVE =
  "0327594738a72fe1a97ffac6dbb012196097d8d8962c4677dd33738e265fc6c0";
const SKIP = new Set(["node_modules", "dist", ".lake", ".git", "data"]);
const SKIP_FILES = new Set([".env"]);

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
      } else if (!SKIP_FILES.has(entry.name)) {
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
    projectId: "450de4b7-0ce3-461d-bf4e-ff07458ae998",
    taskId: "a465e2f3-38d2-4387-897a-b1a45006b302",
    archiveSha256,
    sourceSha256,
    sourceUnmodified: false,
    archiveVerified: archiveSha256 === EXPECTED_ARCHIVE,
    productionHardened: true,
    checkedAt: new Date().toISOString()
  };
}

export function hashProof(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}
