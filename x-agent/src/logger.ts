type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const configuredLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";

function shouldLog(level: LogLevel): boolean {
  return rank[level] >= rank[configuredLevel];
}

export const logger = {
  debug(message: string, meta?: unknown) {
    if (shouldLog("debug")) console.debug(format("debug", message), meta ?? "");
  },
  info(message: string, meta?: unknown) {
    if (shouldLog("info")) console.info(format("info", message), meta ?? "");
  },
  warn(message: string, meta?: unknown) {
    if (shouldLog("warn")) console.warn(format("warn", message), meta ?? "");
  },
  error(message: string, meta?: unknown) {
    if (shouldLog("error")) console.error(format("error", message), meta ?? "");
  }
};

function format(level: LogLevel, message: string): string {
  return `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
}
