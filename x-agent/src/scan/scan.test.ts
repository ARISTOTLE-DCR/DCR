import test from "node:test";
import assert from "node:assert/strict";
import { parseScanCommand } from "./command.js";
import { classify, evaluateModel } from "./model.js";
import { formatQ96Price, formatReport, historySpanPpm, LEGACY_PONS_FACTORY, PONS_FACTORY, priceReturnPpm, resolvePonsFactory, ScanFailure, TokenScanner, type ScanReport } from "./scanner.js";
import { ScanCache } from "./cache.js";
import { MentionHandler } from "../mention-handler.js";
import { processMentions, StateWriteQueue } from "../mention-processor.js";
import type { BotState } from "../state.js";

const A = "0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a";
test("command parser accepts mention before/after, case-insensitively", () => {
  assert.equal(parseScanCommand(`@Bot /ScAn ${A}`, "bot").kind, "valid");
  assert.equal(parseScanCommand(`/scan ${A} @BOT`, "bot").kind, "valid");
});
test("command parser rejects malformed and ambiguous scans", () => {
  for (const x of ["/scan", "/scan nope", `/scan ${A} ${A}`, `/scan ${A} extra`]) assert.equal(parseScanCommand(x, "bot").kind, "invalid");
  assert.equal(parseScanCommand("@bot hello", "bot").kind, "ordinary");
});
test("PONS validation failures become distinct safe replies", async () => {
  const reasoner = { reply: async () => "ordinary" };
  const scanner = { scan: async () => { throw new ScanFailure("non_pons", "That contract is not a PONS-launched token."); } };
  const h = new MentionHandler("bot", reasoner, scanner as never);
  assert.match(await h.reply({ id: "1", text: `/scan ${A}`, authorId: "x" }), /not a PONS/);
});
test("Q96 orientation is exact and inverse", () => {
  const q96 = 1n << 96n;
  assert.equal(formatQ96Price(q96 * 2n, true), "4");
  assert.equal(formatQ96Price(q96 * 2n, false), "0.25");
  assert.equal(priceReturnPpm(q96, q96 * 2n, true), 3_000_000);
  assert.equal(priceReturnPpm(q96, q96 * 2n, false), -750_000);
});
test("all five classification boundaries", () => {
  assert.equal(classify(55), "STRONG BULLISH"); assert.equal(classify(54), "BULLISH");
  assert.equal(classify(20), "BULLISH"); assert.equal(classify(19), "NEUTRAL");
  assert.equal(classify(-19), "NEUTRAL"); assert.equal(classify(-20), "BEARISH");
  assert.equal(classify(-54), "BEARISH"); assert.equal(classify(-55), "STRONG BEARISH");
});
test("quality shrinks direction and missing data lowers confidence, not bearishness", () => {
  const rich = evaluateModel({ momentumPpm: 500000, recentMomentumPpm: 300000, flowPpm: 900000, activeTransactions: 80, swaps: 100, liquidityWethPpm: 100_000_000, completenessPpm: 1_000_000, historySpanPpm: 1_000_000 });
  const thin = evaluateModel({ momentumPpm: 500000, recentMomentumPpm: 300000, flowPpm: 900000, activeTransactions: 1, swaps: 1, liquidityWethPpm: 1000, completenessPpm: 1_000_000, historySpanPpm: 1_000_000 });
  const missing = evaluateModel({ activeTransactions: 0, swaps: 0, completenessPpm: 500_000, historySpanPpm: 500_000 });
  assert.ok(rich.score > thin.score); assert.equal(missing.score, 0); assert.ok(missing.confidence < rich.confidence);
  assert.deepEqual(evaluateModel({ momentumPpm: 1, recentMomentumPpm: 2, flowPpm: 3, activeTransactions: 4, swaps: 5, liquidityWethPpm: 6, completenessPpm: 7, historySpanPpm: 8 }), evaluateModel({ momentumPpm: 1, recentMomentumPpm: 2, flowPpm: 3, activeTransactions: 4, swaps: 5, liquidityWethPpm: 6, completenessPpm: 7, historySpanPpm: 8 }));
});
test("formatter is complete and at most 275 characters", () => {
  const result = evaluateModel({ momentumPpm: 100000, recentMomentumPpm: 50000, flowPpm: 500000, activeTransactions: 20, swaps: 30, liquidityWethPpm: 10_000_000, completenessPpm: 1_000_000, historySpanPpm: 1_000_000 });
  const report = { symbol: "A_VERY_LONG_SYMBOL", token: A, pool: A, finalizedBlock: 1, price: "1", swaps: 30, result, text: "" } satisfies ScanReport;
  const text = formatReport(report); assert.ok(text.length <= 275); assert.ok(!text.endsWith("…")); assert.match(text, /confidence/);
});
test("cache deduplicates concurrent loads and serves completed value", async () => {
  const cache = new ScanCache<number>(1000); let calls = 0;
  const load = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return 7; };
  assert.deepEqual(await Promise.all([cache.run("x", load), cache.run("x", load)]), [7, 7]);
  assert.equal(await cache.run("x", load), 7); assert.equal(calls, 1);
});
test("factory resolution accepts active and legacy membership and rejects absence", async () => {
  const record = (token: string, exists: boolean) => ({ token, exists });
  const active = await resolvePonsFactory(A, async (factory) => record(A, factory === PONS_FACTORY));
  assert.equal(active.factoryAddress, PONS_FACTORY);
  const legacy = await resolvePonsFactory(A, async (factory) => record(A, factory === LEGACY_PONS_FACTORY));
  assert.equal(legacy.factoryAddress, LEGACY_PONS_FACTORY);
  await assert.rejects(resolvePonsFactory(A, async () => record(A, false)), (e: unknown) => e instanceof ScanFailure && e.category === "non_pons");
  await assert.rejects(resolvePonsFactory(A, async (factory) => {
    if (factory === LEGACY_PONS_FACTORY) throw new Error("unavailable");
    return record(A, true);
  }), (e: unknown) => e instanceof ScanFailure && e.category === "rpc_unavailable");
});

test("fresh analyzable history lowers confidence and shrinks score", () => {
  assert.equal(historySpanPpm(100_000, 100_000 - 360), 16_667);
  const base = { momentumPpm: 900_000, recentMomentumPpm: 800_000, flowPpm: 900_000, activeTransactions: 80, swaps: 100, liquidityWethPpm: 100_000_000, completenessPpm: 1_000_000 };
  const fresh = evaluateModel({ ...base, historySpanPpm: historySpanPpm(100_000, 99_640) });
  const mature = evaluateModel({ ...base, historySpanPpm: historySpanPpm(100_000, 78_400) });
  assert.ok(fresh.confidence < 5); assert.ok(fresh.score < mature.score); assert.equal(mature.confidence, 100);
});

test("TokenScanner sequential TTL path reuses latest completed report", async () => {
  const scanner = new TokenScanner({ rpcUrl: "http://127.0.0.1:1", cacheTtlMs: 10_000 });
  let calls = 0;
  const report = { token: A, symbol: "T", pool: A, finalizedBlock: 42, price: "1", swaps: 1, result: evaluateModel({ activeTransactions: 0, swaps: 0, completenessPpm: 0, historySpanPpm: 0 }), text: "x" } satisfies ScanReport;
  (scanner as unknown as { scanFresh(token: string): Promise<ScanReport> }).scanFresh = async () => { calls++; return report; };
  assert.equal(await scanner.scan(A), report);
  assert.equal(await scanner.scan(A), report);
  assert.equal(calls, 1);
});

test("negative dominant flow is rendered as sell pressure", () => {
  const result = evaluateModel({ momentumPpm: 0, recentMomentumPpm: 0, flowPpm: -1_000_000, activeTransactions: 20, swaps: 30, liquidityWethPpm: 10_000_000, completenessPpm: 1_000_000, historySpanPpm: 1_000_000 });
  assert.match(result.dominant, /sell pressure/); assert.doesNotMatch(result.dominant, /buy flow/);
});

test("fast reply is durably persisted before delayed scan finishes", async () => {
  const state: BotState = { processedIds: [] }; const snapshots: BotState[] = [];
  let release!: () => void; const delayed = new Promise<void>((resolve) => { release = resolve; });
  const handler = { reply: async (mention: { id: string }) => { if (mention.id === "2") await delayed; return "ok"; } };
  const publisher = { reply: async () => undefined };
  const writes = new StateWriteQueue(async (snapshot) => { snapshots.push(snapshot); });
  const running = processMentions([{ id: "1", text: "ordinary", authorId: "a" }, { id: "2", text: "/scan", authorId: "b" }], "2", state, handler as never, publisher, writes);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(snapshots.some((snapshot) => snapshot.processedIds.includes("1")));
  assert.ok(!state.processedIds.includes("2"));
  release(); await running;
  assert.ok(snapshots.some((snapshot) => snapshot.processedIds.includes("2")));
});

test("ordinary mentions retain reasoner path", async () => {
  let called = 0; const reasoner = { reply: async () => { called++; return "Claude reply"; } };
  const scanner = { scan: async () => { throw new Error("must not scan"); } };
  const h = new MentionHandler("bot", reasoner, scanner as never);
  assert.equal(await h.reply({ id: "1", text: "@bot explain curvature", authorId: "x" }), "Claude reply"); assert.equal(called, 1);
});
