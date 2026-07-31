import cors from "cors";
import express from "express";
import { JsonRpcProvider, getAddress } from "ethers";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { Store } from "./db.js";
import { Observer } from "./observer.js";
import { buildProvenance } from "./provenance.js";

const app = express();
const store = new Store(config.dataDir);
const baseTarget = {
  rpc: config.rpc,
  token: config.token,
  agentRoot: config.agentRoot,
  stateFile: config.stateFile,
  agentDataDir: config.agentDataDir,
  pollMs: config.pollMs
};
const observer = new Observer(store, baseTarget);
const clients = new Set<express.Response>();
const tokenClients = new Map<string, Set<express.Response>>();
const tokenObservers = new Map<string, { observer: Observer; store: Store }>();
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

function broadcastToken(token: string, event: string, payload: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of tokenClients.get(token.toLowerCase()) ?? []) client.write(message);
}

function resolveToken(address: string): { observer: Observer; store: Store } | undefined {
  try { return tokenObservers.get(getAddress(address).toLowerCase()); }
  catch { return undefined; }
}

function refreshTokenRegistry(): void {
  let records: Array<{ stage?: string; tokenAddress?: string }> = [];
  try {
    const parsed = JSON.parse(readFileSync(config.launchRegistryFile, "utf8")) as { records?: typeof records };
    records = Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return;
  }
  for (const record of records) {
    if (record.stage !== "launched" || !record.tokenAddress) continue;
    let token: string;
    try { token = getAddress(record.tokenAddress); }
    catch { continue; }
    const key = token.toLowerCase();
    if (tokenObservers.has(key)) continue;
    const slug = key.replace(/^0x/, "");
    const agentDataDir = join(config.agentRoot, "data", slug);
    const targetStore = new Store(join(config.fleetDataRoot, slug));
    targetStore.setProvenance(store.provenance()!);
    const targetObserver = new Observer(targetStore, {
      rpc: config.rpc,
      token,
      agentRoot: config.agentRoot,
      stateFile: join(agentDataDir, "state.json"),
      agentDataDir,
      pollMs: config.pollMs
    });
    targetObserver.subscribe((snapshot) => broadcastToken(key, "snapshot", snapshot));
    tokenObservers.set(key, { observer: targetObserver, store: targetStore });
    targetObserver.start();
  }
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
app.use(cors({ origin: false }));
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  next();
});
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

app.get("/api/tokens", (_request, response) => {
  response.json({ tokens: [...tokenObservers.keys()] });
});

app.get("/api/token/:address/status", (request, response) => {
  const target = resolveToken(request.params.address);
  if (!target) return void response.status(404).json({ error: "Unknown launched token." });
  response.json({ snapshot: target.store.latestSnapshot(), provenance: target.store.provenance(), pollIntervalMs: config.pollMs });
});

app.get("/api/token/:address/snapshots", (request, response) => {
  const target = resolveToken(request.params.address);
  if (!target) return void response.status(404).json({ error: "Unknown launched token." });
  response.json({ snapshots: target.store.snapshots(Number(request.query.limit ?? 180)) });
});

app.get("/api/token/:address/activity", (request, response) => {
  const target = resolveToken(request.params.address);
  if (!target) return void response.status(404).json({ error: "Unknown launched token." });
  const limit = Number(request.query.limit ?? 100);
  response.json({ activity: target.store.activities(limit), agentEvents: target.store.agentEvents(limit) });
});

app.get("/api/token/:address/stream", (request, response) => {
  let key: string;
  try { key = getAddress(request.params.address).toLowerCase(); }
  catch { return void response.status(400).json({ error: "Invalid token address." }); }
  if (!tokenObservers.has(key)) return void response.status(404).json({ error: "Unknown launched token." });
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.write(`event: ready\ndata: ${JSON.stringify({ ok: true, block: liveBlock })}\n\n`);
  const set = tokenClients.get(key) ?? new Set<express.Response>();
  set.add(response);
  tokenClients.set(key, set);
  request.on("close", () => {
    set.delete(response);
    if (set.size === 0) tokenClients.delete(key);
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
tokenObservers.set(getAddress(config.token).toLowerCase(), { observer, store });
refreshTokenRegistry();
for (const event of store.agentEvents(500).reverse()) {
  rememberAgentEvent(agentEventKey(event));
}
observer.start();
void refreshLiveBlock();
const headTimer = setInterval(() => void refreshLiveBlock(), 1_000);
const agentEventTimer = setInterval(refreshAgentEvents, 500);
const tokenRegistryTimer = setInterval(refreshTokenRegistry, 5_000);

const server = app.listen(config.port, config.host, () => {
  console.log(`PONS transparency observer: http://${config.host}:${config.port}`);
  console.log(`Aristotle archive verified: ${provenance.archiveVerified}`);
  console.log(`Production hardening active: ${provenance.productionHardened}`);
});

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  observer.stop();
  clearInterval(headTimer);
  clearInterval(agentEventTimer);
  clearInterval(tokenRegistryTimer);
  for (const [key, target] of tokenObservers) {
    if (key !== getAddress(config.token).toLowerCase()) target.observer.stop();
  }
  headProvider.destroy();
  for (const client of clients) client.end();
  clients.clear();
  for (const set of tokenClients.values()) for (const client of set) client.end();
  tokenClients.clear();
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
