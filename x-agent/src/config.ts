import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional());

const baseSchema = z.object({
  BOT_HANDLE: z.string().min(1).transform((value) => value.replace(/^@/, "")),
  BOT_USER_ID: z.string().min(1),
  X_BEARER_TOKEN: z.string().min(1),
  X_API_KEY: z.string().min(1),
  X_API_SECRET: z.string().min(1),
  X_ACCESS_TOKEN: optionalString,
  X_ACCESS_SECRET: optionalString,
  X_OAUTH2_CLIENT_ID: optionalString,
  X_OAUTH2_CLIENT_SECRET: optionalString,
  X_OAUTH2_ACCESS_TOKEN: optionalString,
  X_OAUTH2_REFRESH_TOKEN: optionalString,
  X_OAUTH2_TOKEN_FILE: z.string().default(".aristotle-oauth2.json"),
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  MENTION_LOOKBACK_LIMIT: z.coerce.number().int().min(5).max(100).default(20),
  PROCESS_EXISTING_MENTIONS: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  STATE_FILE: z.string().default(".aristotle-state.json"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ROBINHOOD_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  SCAN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(12000),
  SCAN_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(8),
  SCAN_CACHE_TTL_MS: z.coerce.number().int().min(1000).max(600000).default(120000),
  SCAN_MAX_CONCURRENT: z.coerce.number().int().min(1).max(5).default(2),
  LAUNCH_ENABLED: z.string().default("false").transform((value) => value.toLowerCase() === "true"),
  LAUNCH_FUNDER_PRIVATE_KEY: optionalString,
  LAUNCH_WALLET_PASSWORD: optionalString,
  LAUNCH_REGISTRY_FILE: z.string().default("/var/lib/dcr-launcher/registry.json"),
  LAUNCH_KEYSTORE_DIR: z.string().default("/var/lib/dcr-launcher/keystores"),
  LAUNCH_FUNDING_WEI: z.string().regex(/^\d+$/).default("1000000000000000"),
  LAUNCH_FUNDER_MIN_REMAINING_WEI: z.string().regex(/^\d+$/).default("5000000000000000"),
  LAUNCH_CONFIRMATIONS: z.coerce.number().int().min(1).max(20).default(2),
  LAUNCH_GLOBAL_DAILY_LIMIT: z.coerce.number().int().min(1).max(1000).default(25),
  PONS_FACTORY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB"),
  PONS_LAUNCH_CONFIG_ID: z.coerce.number().int().min(0).default(0),
  PONS_DEX_ID: z.coerce.number().int().min(0).default(0),
  PONS_IMAGE_UPLOAD_URL: z.string().url().default("https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/image"),
  LAUNCH_DASHBOARD_BASE_URL: z.string().url().default("https://dcr-rh.tech")
});

const schema = baseSchema.superRefine((value, context) => {
  if (!value.LAUNCH_ENABLED) return;
  if (!value.LAUNCH_FUNDER_PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(value.LAUNCH_FUNDER_PRIVATE_KEY)) {
    context.addIssue({ code: "custom", path: ["LAUNCH_FUNDER_PRIVATE_KEY"], message: "A valid launch funder private key is required when launches are enabled." });
  }
  if (!value.LAUNCH_WALLET_PASSWORD || value.LAUNCH_WALLET_PASSWORD.length < 24) {
    context.addIssue({ code: "custom", path: ["LAUNCH_WALLET_PASSWORD"], message: "Use a launch-wallet password of at least 24 characters." });
  }
  const funding = BigInt(value.LAUNCH_FUNDING_WEI);
  if (funding <= 0n || funding > 1_000_000_000_000_000n) {
    context.addIssue({ code: "custom", path: ["LAUNCH_FUNDING_WEI"], message: "Launch funding must be positive and no greater than 0.001 ETH." });
  }
  if (BigInt(value.LAUNCH_FUNDER_MIN_REMAINING_WEI) < 0n) {
    context.addIssue({ code: "custom", path: ["LAUNCH_FUNDER_MIN_REMAINING_WEI"], message: "Funder reserve cannot be negative." });
  }
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(): AppConfig {
  const config = schema.parse(process.env);
  assertXWriteAuth(config);
  return config;
}

const mockSchema = baseSchema.pick({
  BOT_HANDLE: true,
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_MODEL: true
});

export type MockConfig = z.infer<typeof mockSchema>;

export function loadMockConfig(): MockConfig {
  return mockSchema.parse(process.env);
}

const xAuthSchema = baseSchema.pick({
  X_API_KEY: true,
  X_API_SECRET: true,
  X_ACCESS_TOKEN: true,
  X_ACCESS_SECRET: true,
  X_OAUTH2_ACCESS_TOKEN: true,
  X_OAUTH2_CLIENT_ID: true,
  X_OAUTH2_CLIENT_SECRET: true,
  X_OAUTH2_REFRESH_TOKEN: true,
  X_OAUTH2_TOKEN_FILE: true
});

export type XAuthConfig = z.infer<typeof xAuthSchema>;

export function loadXAuthConfig(): XAuthConfig {
  const config = xAuthSchema.parse(process.env);
  assertXWriteAuth(config);
  return config;
}

function assertXWriteAuth(config: Pick<AppConfig, "X_ACCESS_TOKEN" | "X_ACCESS_SECRET" | "X_OAUTH2_ACCESS_TOKEN" | "X_OAUTH2_CLIENT_ID">): void {
  const hasOAuth1 = Boolean(config.X_ACCESS_TOKEN && config.X_ACCESS_SECRET);
  const hasOAuth2 = Boolean(config.X_OAUTH2_ACCESS_TOKEN || config.X_OAUTH2_CLIENT_ID);
  if (!hasOAuth1 && !hasOAuth2) {
    throw new Error("Set either OAuth 1.0 X_ACCESS_TOKEN + X_ACCESS_SECRET or OAuth2 X_OAUTH2_ACCESS_TOKEN credentials.");
  }
}
