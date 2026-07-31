import { Contract, FetchRequest, Interface, JsonRpcProvider, ZeroAddress, getAddress, type Log } from "ethers";
import { logger } from "../logger.js";
import { evaluateModel, type ModelResult, type NormalizedObservation } from "./model.js";

export const CHAIN_ID = 4663;
export const PONS_FACTORY = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
export const LEGACY_PONS_FACTORY = "0x0c37a24F5D23A486FA692d1500881d698B1F77a4";
export const PONS_FACTORIES = [PONS_FACTORY, LEGACY_PONS_FACTORY] as const;
export const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const Q96 = 1n << 96n;
const FACTORY_ABI = ["function getLaunchedToken(address) view returns (tuple(address token,address deployer,address pairedToken,address positionManager,uint256 positionId,uint256 dexId,uint256 launchConfigId,uint256 restrictionsEndBlock,uint256 supply,bool isToken0,uint24 poolFee,bool exists,uint256 initialBuyAmount))"];
const TOKEN_ABI = ["function name() view returns(string)", "function symbol() view returns(string)", "function decimals() view returns(uint8)", "function liquidityPool() view returns(address)", "function launchFactory() view returns(address)", "function launchBlock() view returns(uint256)", "function dexFactory() view returns(address)", "function pairToken() view returns(address)", "function poolFee() view returns(uint24)"];
const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns(address)"];
const POOL_ABI = ["function token0() view returns(address)", "function token1() view returns(address)", "function liquidity() view returns(uint128)", "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)"];
const swapInterface = new Interface(["event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"]);

export type ScanFailureCategory = "non_pons" | "rpc_unavailable" | "insufficient_history";
export class ScanFailure extends Error { constructor(public readonly category: ScanFailureCategory, message: string) { super(message); } }
export interface ScanReport { token: string; symbol: string; pool: string; finalizedBlock: number; price: string; swaps: number; result: ModelResult; text: string; }

export interface ScannerOptions { rpcUrl: string; timeoutMs?: number; confirmations?: number; cacheTtlMs?: number; maxConcurrent?: number; }

export class TokenScanner {
  private readonly provider: JsonRpcProvider;
  private readonly cache = new Map<string, { expires: number; report: ScanReport }>();
  private readonly latest = new Map<string, { expires: number; report: ScanReport }>();
  private readonly inflight = new Map<string, Promise<ScanReport>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly timeoutMs: number;
  private readonly confirmations: number;
  private readonly cacheTtlMs: number;
  private readonly maxConcurrent: number;

  constructor(private readonly options: ScannerOptions) {
    const request = new FetchRequest(options.rpcUrl);
    request.timeout = options.timeoutMs ?? 12_000;
    this.provider = new JsonRpcProvider(request, CHAIN_ID, { staticNetwork: true });
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.confirmations = options.confirmations ?? 8;
    this.cacheTtlMs = options.cacheTtlMs ?? 120_000;
    this.maxConcurrent = options.maxConcurrent ?? 2;
  }

  async scan(address: string): Promise<ScanReport> {
    const token = getAddress(address);
    const cached = this.latest.get(token);
    if (cached && cached.expires > Date.now()) {
      logger.info("scan cache hit", { token, finalizedBlock: cached.report.finalizedBlock });
      return cached.report;
    }
    const existing = this.inflight.get(token);
    if (existing) return existing;
    const task = this.withPermit(async () => {
      const report = await this.scanFresh(token);
      this.latest.set(token, { expires: Date.now() + this.cacheTtlMs, report });
      return report;
    });
    this.inflight.set(token, task);
    try { return await task; } finally { this.inflight.delete(token); }
  }

  private async scanFresh(token: string): Promise<ScanReport> {
    const started = Date.now();
    logger.info("scan start", { token });
    try {
      const network = await this.timed(this.provider.getNetwork());
      if (Number(network.chainId) !== CHAIN_ID) throw new ScanFailure("rpc_unavailable", `RPC is on chain ${network.chainId}, expected ${CHAIN_ID}.`);
      const tip = await this.timed(this.provider.getBlockNumber());
      const finalizedBlock = Math.max(0, tip - this.confirmations);
      logger.info("scan finalized block", { token, finalizedBlock });
      const key = `${CHAIN_ID}:${token}:${finalizedBlock}`;
      const cached = this.cache.get(key);
      if (cached && cached.expires > Date.now()) { logger.info("scan cache hit", { token, finalizedBlock }); return cached.report; }
      const report = await this.observe(token, finalizedBlock);
      this.cache.set(key, { expires: Date.now() + this.cacheTtlMs, report });
      logger.info("scan completion", { token, finalizedBlock, classification: report.result.label, score: report.result.score, durationMs: Date.now() - started });
      return report;
    } catch (error) {
      const failure = normalizeFailure(error);
      logger.warn("scan failure", { token, category: failure.category, durationMs: Date.now() - started });
      throw failure;
    }
  }

  private async observe(token: string, block: number): Promise<ScanReport> {
    const code = await this.timed(this.provider.getCode(token, block));
    if (code === "0x") throw new ScanFailure("non_pons", "No contract exists at that address.");
    const runner = this.provider;
    const membership = await resolvePonsFactory(token, async (factoryAddress) => {
      const factory = new Contract(factoryAddress, FACTORY_ABI, runner);
      return this.timed(factory.getLaunchedToken(token, { blockTag: block }));
    });
    const { factoryAddress, launched } = membership;
    if (getAddress(launched.pairedToken) !== getAddress(WETH)) throw new ScanFailure("non_pons", "PONS launch has an unsupported pair.");
    if (BigInt(launched.poolFee) !== 10_000n) throw new ScanFailure("non_pons", "PONS launch has an unsupported fee tier.");

    const tokenContract = new Contract(token, TOKEN_ABI, runner);
    const poolFactory = new Contract(V3_FACTORY, V3_FACTORY_ABI, runner);
    const reads = await Promise.all([
      this.timed(tokenContract.liquidityPool({ blockTag: block })), this.timed(tokenContract.launchFactory({ blockTag: block })),
      this.timed(poolFactory.getPool(token, WETH, launched.poolFee, { blockTag: block })),
      safeRead(() => this.timed(tokenContract.symbol({ blockTag: block }))),
      safeRead(() => this.timed(tokenContract.name({ blockTag: block }))),
      safeRead(() => this.timed(tokenContract.decimals({ blockTag: block }))),
      safeRead(() => this.timed(tokenContract.launchBlock({ blockTag: block }))),
      safeRead(() => this.timed(tokenContract.dexFactory({ blockTag: block }))),
      safeRead(() => this.timed(tokenContract.pairToken({ blockTag: block }))),
      safeRead(() => this.timed(tokenContract.poolFee({ blockTag: block })))
    ]);
    const [reportedPool, launchFactory, canonicalPool, symbolRead, _nameRead, decimalsRead, launchBlockRead, dexFactoryRead, pairTokenRead, poolFeeRead] = reads;
    if (getAddress(launchFactory as string) !== getAddress(factoryAddress)) throw new ScanFailure("non_pons", "Token launch factory does not match its PONS registry.");
    // Older deployed tokens expose these immutable identity getters; validate
    // every getter that exists rather than assuming one token version.
    if (dexFactoryRead !== undefined && getAddress(dexFactoryRead as string) !== getAddress(V3_FACTORY)) throw new ScanFailure("non_pons", "Token DEX factory is invalid.");
    if (pairTokenRead !== undefined && getAddress(pairTokenRead as string) !== getAddress(WETH)) throw new ScanFailure("non_pons", "Token pair identity is invalid.");
    if (poolFeeRead !== undefined && BigInt(poolFeeRead as bigint) !== BigInt(launched.poolFee)) throw new ScanFailure("non_pons", "Token fee identity is invalid.");
    if (canonicalPool === ZeroAddress || getAddress(reportedPool as string) !== getAddress(canonicalPool as string)) throw new ScanFailure("non_pons", "Token pool is not the canonical V3 pool.");
    const pool = new Contract(canonicalPool as string, POOL_ABI, runner);
    const [token0, token1, liquidity, slot0] = await Promise.all([
      this.timed(pool.token0({ blockTag: block })), this.timed(pool.token1({ blockTag: block })), this.timed(pool.liquidity({ blockTag: block })), this.timed(pool.slot0({ blockTag: block }))
    ]);
    const isToken0 = getAddress(token0) === token;
    if (!((isToken0 && getAddress(token1) === getAddress(WETH)) || (getAddress(token1) === token && getAddress(token0) === getAddress(WETH)))) throw new ScanFailure("non_pons", "Canonical pool token pair is invalid.");
    if (Boolean(launched.isToken0) !== isToken0) throw new ScanFailure("non_pons", "PONS orientation does not match the canonical pool.");

    const finalBlock = await this.timed(this.provider.getBlock(block));
    if (!finalBlock) throw new ScanFailure("rpc_unavailable", "Finalized block is unavailable.");
    const target6h = finalBlock.timestamp - 6 * 3600;
    const target1h = finalBlock.timestamp - 3600;
    const from6h = await this.blockAtOrAfter(target6h, block);
    const from1h = await this.blockAtOrAfter(target1h, block);
    const logResult = await this.adaptiveLogs(canonicalPool as string, from6h, block);
    if (logResult.logs.length === 0) throw new ScanFailure("insufficient_history", "No analyzable swaps were observed in the six-hour window.");

    const swaps = logResult.logs.map((log) => ({ log, parsed: swapInterface.parseLog(log)! }));
    const earliest = swaps[0]!.parsed.args.sqrtPriceX96 as bigint;
    const oneHour = swaps.find((x) => x.log.blockNumber >= from1h)?.parsed.args.sqrtPriceX96 as bigint | undefined;
    const current = slot0[0] as bigint;
    const returnPpm = priceReturnPpm(earliest, current, isToken0);
    const recentReturnPpm = priceReturnPpm(oneHour ?? earliest, current, isToken0);
    let signedWeth = 0n, absoluteWeth = 0n;
    const transactions = new Set<string>();
    for (const { parsed, log } of swaps) {
      const amount = (isToken0 ? parsed.args.amount1 : parsed.args.amount0) as bigint;
      signedWeth += amount; absoluteWeth += amount < 0n ? -amount : amount;
      transactions.add(log.transactionHash);
    }
    const flowPpm = absoluteWeth === 0n ? undefined : Number(signedWeth * 1_000_000n / absoluteWeth);
    const wethVirtual = isToken0 ? (liquidity as bigint) * current / Q96 : (liquidity as bigint) * Q96 / current;
    const earliestSwapBlock = await this.timed(this.provider.getBlock(swaps[0]!.log.blockNumber));
    if (!earliestSwapBlock) throw new ScanFailure("rpc_unavailable", "Earliest swap block is unavailable.");
    const launchBlockNumber = launchBlockRead === undefined ? undefined : Number(launchBlockRead);
    const launchBlock = launchBlockNumber === undefined ? undefined : await this.timed(this.provider.getBlock(launchBlockNumber));
    const analyzableStart = Math.max(target6h, earliestSwapBlock.timestamp, launchBlock?.timestamp ?? 0);
    const observation: NormalizedObservation = {
      momentumPpm: returnPpm, recentMomentumPpm: recentReturnPpm, flowPpm, activeTransactions: transactions.size, swaps: swaps.length,
      liquidityWethPpm: Number((wethVirtual / 1_000_000_000_000n) > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : wethVirtual / 1_000_000_000_000n),
      completenessPpm: logResult.complete ? 1_000_000 : 650_000, historySpanPpm: historySpanPpm(finalBlock.timestamp, analyzableStart)
    };
    const result = evaluateModel(observation);
    const symbol = sanitizeSymbol(typeof symbolRead === "string" ? symbolRead : "TOKEN");
    const tokenDecimals = typeof decimalsRead === "bigint" ? Number(decimalsRead) : 18;
    const price = formatQ96Price(current, isToken0, tokenDecimals);
    const report: ScanReport = { token, symbol, pool: getAddress(canonicalPool as string), finalizedBlock: block, price, swaps: swaps.length, result, text: "" };
    report.text = formatReport(report);
    return report;
  }

  private async blockAtOrAfter(timestamp: number, hi: number): Promise<number> {
    // Find a timestamp bracket by exponentially widening block distance; this
    // remains logarithmic even on sub-second chains and never scans all blocks.
    let lo = hi, step = 100_000;
    for (let i = 0; i < 12; i++) {
      lo = Math.max(0, hi - step);
      const b = await this.timed(this.provider.getBlock(lo));
      if (!b) throw new Error("block missing");
      if (b.timestamp < timestamp || lo === 0) break;
      step *= 2;
    }
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const b = await this.timed(this.provider.getBlock(mid)); if (!b) throw new Error("block missing"); if (b.timestamp < timestamp) lo = mid + 1; else hi = mid; }
    return lo;
  }

  private async adaptiveLogs(address: string, from: number, to: number): Promise<{ logs: Log[]; complete: boolean }> {
    const logs: Log[] = []; let cursor = from; let chunk = 2_000; let requests = 0; let complete = true;
    while (cursor <= to && requests < 80) {
      const end = Math.min(to, cursor + chunk - 1); requests++;
      try { const batch = await this.timed(this.provider.getLogs({ address, topics: [SWAP_TOPIC], fromBlock: cursor, toBlock: end })); logs.push(...batch); cursor = end + 1; chunk = Math.min(5_000, Math.floor(chunk * 1.5)); }
      catch { if (chunk <= 50) { complete = false; cursor = end + 1; } else chunk = Math.max(50, Math.floor(chunk / 2)); }
    }
    if (cursor <= to) complete = false;
    return { logs: logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index), complete };
  }

  private async timed<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), this.timeoutMs))]);
  }
  private async withPermit<T>(fn: () => Promise<T>): Promise<T> { if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiters.push(r)); this.active++; try { return await fn(); } finally { this.active--; this.waiters.shift()?.(); } }
}

export function historySpanPpm(finalTimestamp: number, analyzableStartTimestamp: number, windowSeconds = 6 * 3600): number {
  const span = Math.max(0, finalTimestamp - analyzableStartTimestamp);
  return Math.min(1_000_000, Math.round(span * 1_000_000 / windowSeconds));
}

export function priceReturnPpm(oldSqrt: bigint, newSqrt: bigint, tokenIsToken0: boolean): number {
  if (oldSqrt <= 0n || newSqrt <= 0n) return 0;
  const old2 = oldSqrt * oldSqrt, new2 = newSqrt * newSqrt;
  const value = tokenIsToken0 ? (new2 - old2) * 1_000_000n / old2 : (old2 - new2) * 1_000_000n / new2;
  return Number(value > 10_000_000n ? 10_000_000n : value < -10_000_000n ? -10_000_000n : value);
}

export function formatQ96Price(sqrt: bigint, tokenIsToken0: boolean, tokenDecimals = 18): string {
  const decimalFactor = 10n ** BigInt(Math.max(0, Math.min(36, tokenDecimals)));
  const wethFactor = 10n ** 18n;
  const n = (tokenIsToken0 ? sqrt * sqrt : Q96 * Q96) * decimalFactor;
  const d = (tokenIsToken0 ? Q96 * Q96 : sqrt * sqrt) * wethFactor;
  const scaled = n * 1_000_000_000n / d;
  if (scaled === 0n) return "<0.000000001";
  const whole = scaled / 1_000_000_000n, frac = (scaled % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

export function formatReport(r: ScanReport): string {
  const m = r.result.metrics;
  const text = `${r.symbol} — ${r.result.label} | score ${signed(r.result.score)}/100 | confidence ${r.result.confidence}% | 6h momentum ${signed(m.momentum)}, flow ${signed(m.flow)}, depth ${m.depth}, breadth ${m.breadth} | ${r.result.dominant}. Quantitative state, not advice.`;
  if (text.length <= 275) return text;
  const compact = `${r.symbol} — ${r.result.label} | ${signed(r.result.score)}/100, confidence ${r.result.confidence}% | momentum ${signed(m.momentum)}, flow ${signed(m.flow)}, depth ${m.depth}, breadth ${m.breadth} | ${r.result.dominant}. Not advice.`;
  if (compact.length > 275) throw new Error("Report cannot fit in one reply");
  return compact;
}
const signed = (n: number) => n > 0 ? `+${n}` : String(n);
const sanitizeSymbol = (s: string) => s.replace(/[^A-Za-z0-9_$.-]/g, "").slice(0, 16) || "TOKEN";

export interface FactoryLaunchRecord { token: string; exists: boolean; }

/** Resolve membership against every immutable official registry. A failed
 * registry read cannot be treated as a negative membership result. */
export async function resolvePonsFactory<T extends FactoryLaunchRecord>(
  token: string,
  read: (factoryAddress: string) => Promise<T>
): Promise<{ factoryAddress: string; launched: T }> {
  const matches: Array<{ factoryAddress: string; launched: T }> = [];
  let successfulReads = 0;
  for (const factoryAddress of PONS_FACTORIES) {
    try {
      const launched = await read(factoryAddress);
      successfulReads++;
      if (launched.exists && getAddress(launched.token) === getAddress(token)) matches.push({ factoryAddress, launched });
    } catch { /* Preserve uncertainty; handled below. */ }
  }
  if (successfulReads !== PONS_FACTORIES.length) throw new ScanFailure("rpc_unavailable", "PONS membership data is temporarily unavailable.");
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new ScanFailure("non_pons", "Token appears in multiple PONS registries.");
  throw new ScanFailure("non_pons", "That contract is not a PONS-launched token.");
}

async function safeRead<T>(fn: () => Promise<T>): Promise<T | undefined> { try { return await fn(); } catch { return undefined; } }
function normalizeFailure(error: unknown): ScanFailure { if (error instanceof ScanFailure) return error; return new ScanFailure("rpc_unavailable", "Robinhood Chain data is temporarily unavailable; try again shortly."); }
