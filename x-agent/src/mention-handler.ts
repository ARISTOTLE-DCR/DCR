import type { Mention } from "./types.js";
import { logger } from "./logger.js";
import { parseScanCommand } from "./scan/command.js";
import { ScanFailure, type TokenScanner } from "./scan/scanner.js";
import { parseLaunchCommand } from "./launch/command.js";

export interface ReplyReasoner { reply(mention: Mention): Promise<string>; }
export interface LaunchHandler { handle(mention: Mention, request: string): Promise<string>; }

export class MentionHandler {
  constructor(
    private readonly botHandle: string,
    private readonly reasoner: ReplyReasoner,
    private readonly scanner: Pick<TokenScanner, "scan">,
    private readonly launcher?: LaunchHandler
  ) {}

  async reply(mention: Mention): Promise<string> {
    const launchCommand = parseLaunchCommand(mention.text, this.botHandle);
    if (launchCommand.kind === "invalid") return launchCommand.message;
    if (launchCommand.kind === "launch") {
      logger.info("command detection", { tweetId: mention.id, command: "launch" });
      return this.launcher
        ? this.launcher.handle(mention, launchCommand.request)
        : "Token launches are not enabled yet.";
    }
    const command = parseScanCommand(mention.text, this.botHandle);
    logger.info("command detection", { tweetId: mention.id, command: command.kind });
    if (command.kind === "ordinary") return this.reasoner.reply(mention);
    if (command.kind === "invalid") return command.message;
    try { return (await this.scanner.scan(command.address)).text; }
    catch (error) {
      if (error instanceof ScanFailure) {
        if (error.category === "non_pons") return `Scan rejected: ${error.message}`;
        if (error.category === "insufficient_history") return "PONS token verified, but recent history is insufficient for a reliable scan. Try again after more trading.";
      }
      return "Robinhood Chain scan data is temporarily unavailable. Please try again shortly.";
    }
  }
}
