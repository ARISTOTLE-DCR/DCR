import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { ReservoirCanvas } from "./ReservoirCanvas";
import { StrategyModal } from "./StrategyModal";
import type {
  Activity,
  AgentEvent,
  Provenance,
  Snapshot
} from "./types";

interface TerminalLine {
  timestamp: string;
  action: string;
  hash: string;
  critical?: boolean;
}

const twitterUrl =
  import.meta.env.VITE_TWITTER_URL ?? "https://x.com/discreteonrh";
const tickerCode = (import.meta.env.VITE_TOKEN_TICKER ?? "DCR")
  .replace(/^\$/, "")
  .toUpperCase();
const displayTicker = `$${tickerCode}`;

function short(value: string, start = 6, end = 4): string {
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function compact(value: string | number, digits = 4): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number === 0) return "0";
  if (Math.abs(number) < 0.0001) return number.toExponential(3);
  return new Intl.NumberFormat("en-US", {
    notation: Math.abs(number) >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: digits
  }).format(number);
}

function clockTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function countdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function agentEventKey(event: AgentEvent): string {
  return `${event.timestamp}:${event.eventType}:${JSON.stringify(event.payload)}`;
}

function mergeAgentEvents(
  current: AgentEvent[],
  incoming: AgentEvent[]
): AgentEvent[] {
  const unique = new Map<string, AgentEvent>();
  for (const event of [...current, ...incoming]) {
    unique.set(agentEventKey(event), event);
  }
  return [...unique.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 100);
}

function nextStrategyCycle(events: AgentEvent[]): number | null {
  for (const event of [...events].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp)
  )) {
    const payload = event.payload as {
      nextRunAt?: string;
      line?: string;
    };
    if (event.eventType === "schedule" && payload.nextRunAt) {
      const scheduled = Date.parse(payload.nextRunAt);
      if (Number.isFinite(scheduled)) return scheduled;
    }
    if (event.eventType === "stdout" && payload.line) {
      const match = payload.line.match(/^next cycle in ([0-9.]+) minutes$/);
      if (match) {
        return Date.parse(event.timestamp) + Number(match[1]) * 60_000;
      }
    }
  }
  return null;
}

function decisionLabel(kind: Snapshot["decision"]["kind"]): string {
  if (kind === "permanent_lp") return "LOCK LP";
  if (kind === "weth_airdrop") return "AIRDROP";
  return kind.toUpperCase();
}

function terminalLines(
  snapshot: Snapshot,
  provenance: Provenance,
  activity: Activity[],
  events: AgentEvent[],
  ticker: string
): TerminalLine[] {
  const lines: TerminalLine[] = [];

  for (const item of activity) {
    lines.push({
      timestamp: item.timestamp,
      action: `${item.kind.toUpperCase()}_${item.status.toUpperCase()}`,
      hash: item.txHash ? short(item.txHash, 4, 4).replace("…", "") : `B${item.block ?? 0}`,
      critical: item.status === "failed"
    });
  }

  for (const event of events) {
    const payload = event.payload as {
      decision?: { kind?: string; reason?: string };
      status?: string;
      txHash?: string;
      args?: unknown[];
    };
    if (event.eventType === "cycle" && payload.decision?.kind) {
      lines.push({
        timestamp: event.timestamp,
        action: `DECISION_${payload.decision.kind.toUpperCase()}`,
        hash: `B${snapshot.agent.stateBlock}`,
        critical: false
      });
    } else if (event.eventType === "schedule") {
      const nextRunAt = (event.payload as { nextRunAt?: string }).nextRunAt;
      lines.push({
        timestamp: event.timestamp,
        action: "NEXT_CYCLE_SCHEDULED",
        hash: nextRunAt
          ? clockTime(nextRunAt).replaceAll(":", "")
          : "QUEUED"
      });
    } else if (
      event.eventType === "execution" ||
      event.eventType === "collection" ||
      event.eventType === "lp-recovery" ||
      event.eventType === "airdrop-recovery"
    ) {
      lines.push({
        timestamp: event.timestamp,
        action: `${event.eventType.toUpperCase()}_${String(payload.status ?? "OBSERVED").toUpperCase()}`,
        hash: payload.txHash ? short(payload.txHash, 4, 4).replace("…", "") : "LOCAL",
        critical: payload.status === "failed"
      });
    } else if (
      event.eventType === "stderr" ||
      event.eventType === "warning" ||
      event.eventType === "observer-error"
    ) {
      lines.push({
        timestamp: event.timestamp,
        action: `WARN_${event.eventType.toUpperCase()}`,
        hash: "ERROR",
        critical: true
      });
    }
  }

  lines.push({
    timestamp: snapshot.capturedAt,
    action: `OBSERVER_SYNC_BLOCK_${snapshot.block}`,
    hash: `#${String(snapshot.block).slice(-6)}`
  });

  return lines
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 50);
}

function Barcode() {
  return (
    <div className="barcode" aria-hidden="true">
      {Array.from({ length: 18 }, (_, index) => <span key={index} />)}
    </div>
  );
}

function Loading() {
  return (
    <div className="loading-terminal text-micro">
      <span>SYS.BOOT: DCR_PUBLIC_OBSERVER</span>
      <strong>CONNECTING_TO_ROBINHOOD_CHAIN...</strong>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [liveBlock, setLiveBlock] = useState<number | null>(null);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [pollIntervalMs, setPollIntervalMs] = useState(15_000);
  const [lastRefreshAt, setLastRefreshAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [strategyOpen, setStrategyOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const loadActivity = useCallback(async (): Promise<void> => {
    const result = await api.activity(100);
    setActivity(result.activity);
    setEvents((current) => mergeAgentEvents(current, result.agentEvents));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const status = await api.status();
      setSnapshot(status.snapshot);
      setLiveBlock(status.snapshot?.block ?? null);
      setProvenance(status.provenance);
      setPollIntervalMs(status.pollIntervalMs);
      setLastRefreshAt(Date.now());
      await loadActivity();
    } catch {}
  }, [loadActivity]);

  useEffect(() => {
    void load();
    const stream = new EventSource("/api/stream");
    stream.addEventListener("ready", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        block?: number | null;
      };
      if (typeof payload.block === "number") setLiveBlock(payload.block);
    });
    stream.addEventListener("block", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        block: number;
      };
      setLiveBlock(payload.block);
    });
    stream.addEventListener("snapshot", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as Snapshot;
      setSnapshot(next);
      setLastRefreshAt(Date.now());
      setLiveBlock((current) => Math.max(current ?? 0, next.block));
      void loadActivity();
    });
    stream.addEventListener("agent-event", (event) => {
      const next = JSON.parse(
        (event as MessageEvent<string>).data
      ) as AgentEvent;
      setEvents((current) => mergeAgentEvents(current, [next]));
    });
    return () => stream.close();
  }, [load, loadActivity]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const logs = useMemo(
    () => snapshot && provenance
      ? terminalLines(snapshot, provenance, activity, events, tickerCode)
      : [],
    [snapshot, provenance, activity, events]
  );

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [logs]);

  if (!snapshot || !provenance) return <Loading />;

  const decision = decisionLabel(snapshot.decision.kind);
  const refreshElapsed = Math.max(0, now - lastRefreshAt);
  const refreshRemaining = Math.max(0, pollIntervalMs - refreshElapsed);
  const refreshProgress = Math.min(100, (refreshElapsed / pollIntervalMs) * 100);
  const nextCycleAt =
    snapshot.agent.nextRunAt > 0
      ? snapshot.agent.nextRunAt
      : nextStrategyCycle(events);
  const nextCycleRemaining =
    nextCycleAt === null ? null : nextCycleAt - now;
  const nextCycleLabel = nextCycleRemaining === null
    ? snapshot.agent.online ? "SCHEDULE PENDING" : "AGENT OFFLINE"
    : nextCycleRemaining > 0
      ? `T-${countdown(nextCycleRemaining)}`
      : "CYCLE RUNNING";

  return (
    <>
      <div className="design-grid">
        <header className="header-zone text-micro">
        <div>Discrete Curvature Reservoir</div>
        <div>CHAIN: ROBINHOOD_4663 // BLOCK_{liveBlock ?? snapshot.block}</div>
        <div className="header-actions">
          <a
            className="twitter-link"
            href={twitterUrl}
            rel="noreferrer"
            target="_blank"
          >
            X / TWITTER ↗
          </a>
        </div>
        </header>

        <main className="main-visual-zone">
        <ReservoirCanvas />

        <div className="title-cluster">
          <div className="meta-label text-micro">
            DCR — COUNTERCYCLICAL FEEDBACK CONTROLLER
          </div>
          <h1>
            Discrete
            <br />
            Curvature
            <br />
            Reservoir
          </h1>
          <div className="concept-desc">
            DCR v2 governs PONS creator fees through a buy-biased solvency
            cone. It buys drawdowns, sells only exceptional overextension, and
            routes calm surplus into burns, permanently locked liquidity, or
            transparent WETH distributions to holders.
          </div>
        </div>

        </main>

        <aside className="data-terminal-zone">
        <div className="data-module">
          <div className="data-module-header text-micro">
            <span>STRATEGY_DATA.JSON</span>
          </div>

          <dl className="data-grid text-data">
            <div className="data-point">
              <dt className="text-micro">CURRENT CONTROL ACTION</dt>
              <dd className={`highlight signal-${snapshot.decision.kind}`}>
                {decision}
              </dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">TOKEN / WETH PRICE</dt>
              <dd>{compact(snapshot.pool.priceWeth, 12)} WETH</dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">WETH RESERVOIR</dt>
              <dd>{compact(snapshot.treasury.wethBalance, 8)} WETH</dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">{displayTicker} RESERVOIR</dt>
              <dd>{compact(snapshot.treasury.tokenBalance)} {displayTicker}</dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">MARKET CAP / RECENT WETH FLOW</dt>
              <dd>
                {compact(snapshot.pool.marketCapWeth)} /{" "}
                {compact(snapshot.pool.volumeWeth)} WETH
              </dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">UNCLAIMED CREATOR FEES</dt>
              <dd>{snapshot.claim.status.toUpperCase()}</dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">CYCLE / EXECUTION STATE</dt>
              <dd>
                #{snapshot.agent.cycleSeq} /{" "}
                {snapshot.operations.cycle.stage.toUpperCase()}
              </dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">HOLDER INDEX</dt>
              <dd>
                {snapshot.operations.holderIndex.complete
                  ? `READY / ${snapshot.operations.holderIndex.trackedAddresses}`
                  : `SYNC ${snapshot.operations.holderIndex.cursor} → ${snapshot.operations.holderIndex.target}`}
              </dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">PERMANENT LP</dt>
              <dd>
                {snapshot.operations.lp.stage.toUpperCase()}
                {snapshot.operations.lp.tokenId
                  ? ` / #${snapshot.operations.lp.tokenId}`
                  : ""}
              </dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">WETH AIRDROP</dt>
              <dd>
                {snapshot.operations.airdrop.stage.toUpperCase()} /{" "}
                {snapshot.operations.airdrop.confirmedCount}/
                {snapshot.operations.airdrop.recipientCount}
              </dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">RESERVE ADDRESS</dt>
              <dd className="small-value">
                <a
                  className="explorer-link"
                  href={`https://robinhoodchain.blockscout.com/address/${snapshot.treasury.address}`}
                  rel="noreferrer"
                  target="_blank"
                  title="Open reserve address in Robinhood Chain explorer"
                >
                  {short(snapshot.treasury.address, 10, 8)}
                </a>
              </dd>
            </div>
            <div className="data-point">
              <dt className="text-micro">STRATEGY SOURCE HASH</dt>
              <dd className="small-value">
                {short(provenance.sourceSha256, 10, 8)}
              </dd>
            </div>
          </dl>

          <button
            className="strategy-explainer-button"
            onClick={() => setStrategyOpen(true)}
            type="button"
          >
            <strong>HOW THE STRATEGY WORKS</strong>
            <span className="text-micro">OPEN ↗</span>
          </button>
        </div>

        <div className="log-terminal">
          <div className="log-header text-micro">
            <span>&gt; TERMINAL: DCR_OBSERVER_STREAM</span>
            <span>[LIVE SSE]</span>
          </div>
          <div className="cycle-monitor text-micro">
            <div className="refresh-status">
              <span>DATA REFRESH</span>
              <strong>
                {refreshRemaining > 0
                  ? `T-${countdown(refreshRemaining)}`
                  : "SYNCING"}
              </strong>
            </div>
            <div className="refresh-progress" aria-hidden="true">
              <span style={{ width: `${refreshProgress}%` }} />
            </div>
            <div className="strategy-status">
              <span>NEXT STRATEGY CYCLE</span>
              <strong>{nextCycleLabel}</strong>
            </div>
          </div>
          <div className="log-stream text-micro" ref={logRef}>
            {logs.map((line) => (
              <div
                className={`log-line ${line.critical ? "critical" : ""}`}
                key={`${line.timestamp}-${line.action}-${line.hash}`}
              >
                <span className="log-time">{clockTime(line.timestamp)}</span>
                <span className="log-action">{line.action}</span>
                <span className="log-hash">{line.hash}</span>
              </div>
            ))}
          </div>
        </div>
        </aside>

        <div className="source-link-container">
          <a
            className="source-link"
            href="https://github.com/ARISTOTLE-DCR/DCR"
            rel="noreferrer"
            target="_blank"
          >
            <Barcode />
            <div className="source-link-text">
              <span className="text-micro source-primary">
                // VIEW SOURCE ON GITHUB
              </span>
              <span className="text-micro">ARISTOTLE-DCR/DCR ↗</span>
            </div>
          </a>
        </div>
      </div>

      {strategyOpen && (
        <StrategyModal
          onClose={() => setStrategyOpen(false)}
          ticker={displayTicker}
        />
      )}
    </>
  );
}
