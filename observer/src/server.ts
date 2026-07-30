import cors from "cors";
import express from "express";
import { JsonRpcProvider } from "ethers";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { Store } from "./db.js";
import { Observer } from "./observer.js";
import { buildProvenance } from "./provenance.js";

const app = express();
const store = new Store(config.dataDir);
const observer = new Observer(store);
const clients = new Set<express.Response>();
const seenAgentEventKeys = new Set<string>();
const seenAgentEventOrder: string[] = [];
const headProvider = new JsonRpcProvider(
  config.rpc,
  4663,
  { staticNetwork: true }
);
let liveBlock = store.latestSnapshot()?.block ?? null;
let headRequestPending = false;

function broadcast(event: string, payload: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(message);
}

function agentEventKey(event: {
  timestamp: string;
  eventType: string;
  payload: unknown;
}): string {
  return `${event.timestamp}:${event.eventType}:${JSON.stringify(event.payload)}`;
}

function rememberAgentEvent(key: string): boolean {
  if (seenAgentEventKeys.has(key)) return false;
  seenAgentEventKeys.add(key);
  seenAgentEventOrder.push(key);
  if (seenAgentEventOrder.length > 1_000) {
    const oldest = seenAgentEventOrder.shift();
    if (oldest) seenAgentEventKeys.delete(oldest);
  }
  return true;
}

function refreshAgentEvents(): void {
  const events = store.agentEvents(50).reverse();
  for (const event of events) {
    if (rememberAgentEvent(agentEventKey(event))) {
      broadcast("agent-event", event);
    }
  }
}

async function refreshLiveBlock(): Promise<void> {
  if (headRequestPending) return;
  headRequestPending = true;
  try {
    const block = await headProvider.getBlockNumber();
    if (block !== liveBlock) {
      liveBlock = block;
      broadcast("block", { block, observedAt: new Date().toISOString() });
    }
  } catch {
    // The next one-second tick retries without interrupting the main observer.
  } finally {
    headRequestPending = false;
  }
}

app.disable("x-powered-by");
app.use(cors({ origin: true }));
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    observer: "read-only",
    latestBlock: liveBlock
  });
});

app.get("/api/status", (_request, response) => {
  response.json({
    snapshot: store.latestSnapshot(),
    provenance: store.provenance(),
    pollIntervalMs: config.pollMs
  });
});

app.get("/api/snapshots", (request, response) => {
  const limit = Number(request.query.limit ?? 180);
  response.json({ snapshots: store.snapshots(limit) });
});

app.get("/api/activity", (request, response) => {
  const limit = Number(request.query.limit ?? 100);
  response.json({
    activity: store.activities(limit),
    agentEvents: store.agentEvents(limit)
  });
});

app.get("/api/proof", (_request, response) => {
  response.json({
    provenance: store.provenance(),
    latestSnapshotProof: store.latestSnapshot()?.proofHash ?? null,
    verification: {
      archiveAlgorithm: "SHA-256",
      cycleProofAlgorithm: "SHA-256(JSON snapshot without proofHash)",
      authority: "Robinhood Chain receipts and emitted events"
    }
  });
});

app.get("/api/proof/archive", (_request, response) => {
  response.download(config.archive, "aristotle-result.tar.gz");
});

app.post("/api/refresh", async (_request, response) => {
  try {
    response.json({ snapshot: await observer.poll() });
  } catch (error) {
    response.status(503).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/stream", (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.write(
    `event: ready\ndata: ${JSON.stringify({ ok: true, block: liveBlock })}\n\n`
  );
  clients.add(response);
  request.on("close", () => clients.delete(response));
});

observer.subscribe((snapshot) => {
  broadcast("snapshot", snapshot);
});

if (existsSync(config.dashboardDist)) {
  app.use(express.static(config.dashboardDist, {
    etag: true,
    maxAge: "5m"
  }));
  app.get("/{*splat}", (_request, response) => {
    response.sendFile(join(config.dashboardDist, "index.html"));
  });
}

const provenance = buildProvenance(config.agentRoot, config.archive);
store.setProvenance(provenance);
for (const event of store.agentEvents(500).reverse()) {
  rememberAgentEvent(agentEventKey(event));
}
observer.start();
void refreshLiveBlock();
const headTimer = setInterval(() => void refreshLiveBlock(), 1_000);
const agentEventTimer = setInterval(refreshAgentEvents, 500);

const server = app.listen(config.port, config.host, () => {
  console.log(`PONS transparency observer: http://${config.host}:${config.port}`);
  console.log(`Aristotle source unmodified: ${provenance.sourceUnmodified}`);
});

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  observer.stop();
  clearInterval(headTimer);
  clearInterval(agentEventTimer);
  headProvider.destroy();
  for (const client of clients) client.end();
  clients.clear();
  server.once("close", () => process.exit(0));
  server.close();
  server.closeIdleConnections();
  const forceClose = setTimeout(() => {
    server.closeAllConnections();
    process.exit(0);
  }, 5_000);
  forceClose.unref();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
