import type { Mention } from "./types.js";
import type { BotState } from "./state.js";
import { hasProcessed, markProcessed, maxSnowflake } from "./state.js";
import type { MentionHandler } from "./mention-handler.js";
import { logger } from "./logger.js";

export interface ReplyPublisher { reply(tweetId: string, text: string): Promise<void>; }
export type StateSaver = (state: BotState) => Promise<void>;

/** Serializes durable writes and snapshots mutable state at enqueue time. */
export class StateWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly save: StateSaver) {}

  enqueue(state: BotState): Promise<void> {
    const snapshot: BotState = { sinceId: state.sinceId, processedIds: [...state.processedIds] };
    const write = this.tail.then(() => this.save(snapshot));
    this.tail = write.catch(() => undefined);
    return write;
  }
}

/** Process replies concurrently, but durably record every publication attempt
 * as soon as that attempt ends. Slow scans therefore cannot delay persistence
 * for unrelated ordinary replies. */
export async function processMentions(
  mentions: Mention[],
  newestId: string | undefined,
  state: BotState,
  handler: Pick<MentionHandler, "reply">,
  publisher: ReplyPublisher,
  writes: StateWriteQueue
): Promise<void> {
  await Promise.all(mentions.filter((mention) => !hasProcessed(state, mention.id)).map(async (mention) => {
    try {
      const reply = await handler.reply(mention);
      await publisher.reply(mention.id, reply);
      logger.info("Replied to mention", { tweetId: mention.id, username: mention.username, reply });
    } catch (error) {
      logger.error("Mention handling failed", { tweetId: mention.id, error });
    } finally {
      markProcessed(state, mention.id);
      await writes.enqueue(state);
    }
  }));
  state.sinceId = maxSnowflake([state.sinceId, newestId, ...mentions.map((mention) => mention.id)]);
  await writes.enqueue(state);
}
