This project was edited by [Aristotle](https://aristotle.harmonic.fun).

To cite Aristotle:
- Tag @Aristotle-Harmonic on GitHub PRs/issues
- Add as co-author to commits:
```
Co-authored-by: Aristotle (Harmonic) <aristotle-harmonic@harmonic.fun>
```

# Aristotle X Agent with PONS scanner and launcher

An automated X mention bot retaining the existing DCR conversational persona and adding a deterministic, read-only PONS token scanner for Robinhood Chain.

It also contains a crash-recoverable `/launch` path for creating isolated PONS tokens. Launching is disabled by default and requires explicit server configuration.

## Setup

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
npm run build
npm run x:me
npm run dev
```

`BOT_USER_ID` is the numeric X account id; `npm run x:me` prints it for the OAuth user. Choose either OAuth 1.0 access credentials or OAuth2 credentials. By default, first startup skips existing mentions.

## Commands

Ordinary mentions continue through the existing Claude reasoner. A scan is explicitly requested as:

```text
@handle /scan 0xTokenAddress
/scan 0xTokenAddress @handle
```

Parsing is case-insensitive and accepts exactly one EVM address. A scan performs only finalized public RPC reads; no signer, private key, transaction, portfolio, buy, or sell is involved. The one-reply result is deterministic and at most 275 JavaScript characters.

For a local read-only scan:

```bash
npm run scan -- 0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a
```

The CLI prints the X reply plus a compact verification record. See `SCAN_MODEL.md` for the derivation, assumptions, formulas, classifications, and confidence treatment.

### Launch a PONS token

```text
@handle /launch Name: Curved Cat | Ticker: CCAT | Description: optional | Website: optional
```

Name and ticker are required. Description, X/Telegram/Discord/Farcaster, website and one attached PNG/JPEG/WebP image are optional. The AI extracts the fields, then deterministic validation enforces PONS limits before any transaction is prepared.

For each accepted launch the service:

- allows one launch per X author ID per rolling 24 hours;
- applies a configurable global daily budget cap (default 25 launches);
- creates an encrypted, independent creator wallet;
- funds exactly at most `0.001 ETH` after a live fee/gas preflight;
- refuses funding if it would leave the funder below its protected native-ETH gas reserve (default `0.005 ETH`);
- pays only the current PONS launch fee, so the initial buy is the contract minimum of zero;
- persists signed transaction bytes before broadcast and recovers the same transaction after a crash;
- returns the verified token CA and `https://dcr-rh.tech/token/<CA>`;
- lets the DCR fleet supervisor run an isolated strategy/data directory for that token.

The generated wallet remains the token creator and PONS fee recipient. It never shares token/WETH reserves with DCR or another launch. The fleet may unwrap only that wallet's WETH when its native gas balance is low.

Read-only current-contract preflight (never sends a transaction):

```bash
npm run launch:preflight
```

Keep `LAUNCH_ENABLED=false` until the registry directories, shared nonce lock, wallet password, funder key, fleet service and observer routes have all been deployed and verified.

## Scanner configuration

- `ROBINHOOD_RPC_URL` (default `https://rpc.mainnet.chain.robinhood.com`): chain-4663 JSON-RPC.
- `SCAN_TIMEOUT_MS` (default `12000`): hard timeout per RPC operation.
- `SCAN_CONFIRMATIONS` (default `8`): blocks omitted for reorg safety.
- `SCAN_CACHE_TTL_MS` (default `120000`): completed report TTL. Reports retain `(chain, token, finalized block)` identity; same-token requests within TTL reuse the latest completed report before fetching a newer tip.
- `SCAN_MAX_CONCURRENT` (default `2`): global scan concurrency ceiling.

Adaptive log requests range from 50 to 5,000 blocks with a hard request budget. Incomplete reads lower confidence rather than silently becoming zero. Same-token concurrent requests are coalesced. Mention handling within a poll is concurrent so a slow scan does not hold ordinary replies; each publication attempt is queued for durable state persistence immediately, with serialized snapshot writes.

## Local prompt test

```bash
npm run mock -- "@aristotle is volatility just variance?"
```

## Verification

Verification performed on 2026-07-31:

- Clean `npm ci`: passed; 25 packages installed and 0 vulnerabilities reported. `npm audit --audit-level=low`: 0 vulnerabilities.
- `npm run typecheck`: passed.
- `npm test`: 14/14 deterministic test groups passed. New regressions cover active/legacy/absent factory resolution, actual fresh-history confidence shrinkage, the real `TokenScanner` sequential TTL path, sign-correct flow wording, and immediate serialized state persistence while a scan is delayed.
- `npm run build`: passed.
- Active fixture DCR `0x29b9…0c7a`: passed at finalized block `24062388`; canonical pool `0x1D78…a0A2`, 793 swaps, `BEARISH`, score `-31`, confidence `100%`.
- Active NASDANQ `0x142a…dd06`: passed at block `24065593`; canonical pool `0x9DF6…3818`, 16 swaps, `BEARISH`, score `-27`, confidence `80%`.
- Active SADBOY `0xbe28…3C65`: passed at block `24065919`; canonical pool `0xB7a1…7426`, 4 swaps, `NEUTRAL`, score `-17`, confidence `59%`.
- Active fresh launches WOLFSPEED `0x8813…bfcC` and VEFI `0xFA2a…8Fe9`: passed at blocks `24062734` and `24063091`; their actual analyzable history produced confidence `6%` (not the prior erroneous 100%) and scores `-3` and `-2`, respectively.
- Official legacy PONS `0x39dB…4571`: passed at block `24062046` through legacy factory `0x0c37…77a4`; canonical pool `0x10CC…26bA`, 703 swaps, `NEUTRAL`, score `-5`, confidence `99%`.
- Timed same-instance VEFI cache check: first scan 3277 ms, immediately sequential scan 0 ms; both returned the same report object and finalized block `24063860`.
- Invalid address `0x1234`: rejected before RPC. Existing non-PONS WETH `0x0Bd7…AD73`: contract existence passed and membership in both official factories was rejected.

The scanner classification is a quantitative market-state label, not personalized financial advice and not a prediction guarantee.
