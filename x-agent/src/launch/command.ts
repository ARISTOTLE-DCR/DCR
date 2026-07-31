export type LaunchCommand =
  | { kind: "ordinary" }
  | { kind: "invalid"; message: string }
  | { kind: "launch"; request: string };

export function parseLaunchCommand(text: string, botHandle: string): LaunchCommand {
  const matches = [...text.matchAll(/(?:^|\s)\/launch\b/gi)];
  if (matches.length === 0) return { kind: "ordinary" };
  if (matches.length !== 1) {
    return { kind: "invalid", message: "Use one /launch command per post." };
  }

  const start = (matches[0].index ?? 0) + matches[0][0].length;
  const request = text
    .slice(start)
    .replace(new RegExp(`@${escapeRegex(botHandle)}\\b`, "gi"), "")
    .trim();
  if (!request) {
    return {
      kind: "invalid",
      message: "Usage: /launch Name: Token Name | Ticker: TICKER | Description: optional | Website: optional"
    };
  }
  return { kind: "launch", request };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
