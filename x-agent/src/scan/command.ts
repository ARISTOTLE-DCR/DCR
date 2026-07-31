import { getAddress, isAddress } from "ethers";

export type ScanCommand =
  | { kind: "ordinary" }
  | { kind: "valid"; address: string }
  | { kind: "invalid"; message: string };

/** Deterministic /scan grammar. Mentions may occur anywhere, but no other words may. */
export function parseScanCommand(text: string, botHandle: string): ScanCommand {
  const mentions = [...text.matchAll(/@([A-Za-z0-9_]{1,15})/g)];
  const withoutMentions = text.replace(/@([A-Za-z0-9_]{1,15})/g, " ").trim();
  if (!/\/scan\b/i.test(withoutMentions)) return { kind: "ordinary" };
  if (mentions.some((m) => m[1]!.toLowerCase() !== botHandle.toLowerCase())) {
    return { kind: "invalid", message: "Invalid /scan syntax. Use: /scan 0x… (one token address only)." };
  }
  const match = withoutMentions.match(/^\/scan\s+(\S+)$/i);
  if (!match || !isAddress(match[1]!)) {
    return { kind: "invalid", message: "Invalid /scan syntax. Use: /scan 0x… (one token address only)." };
  }
  return { kind: "valid", address: getAddress(match[1]!) };
}
