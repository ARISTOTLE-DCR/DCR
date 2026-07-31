import { loadMockConfig } from "../config.js";
import { AristotleReasoner } from "../reasoner.js";
import type { Mention } from "../types.js";

const config = loadMockConfig();
const parsed = parseArgs(process.argv.slice(2));

if (!parsed.text) {
  console.error('Usage: npm run mock -- "@aristotle explain why volatility is not risk" --username alice');
  process.exit(1);
}

const reasoner = new AristotleReasoner(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL, config.BOT_HANDLE);
const mention: Mention = {
  id: `mock-${Date.now()}`,
  text: parsed.text,
  authorId: parsed.userId ?? "mock-user",
  username: parsed.username,
  contextPost: parsed.contextText
    ? {
        id: `mock-context-${Date.now()}`,
        text: parsed.contextText,
        username: parsed.contextUsername
      }
    : undefined
};

const reply = await reasoner.reply(mention);
console.log(`[reply] ${reply}`);
console.log(`[length] ${reply.length}`);

function parseArgs(args: string[]): {
  text: string;
  username?: string;
  userId?: string;
  contextText?: string;
  contextUsername?: string;
} {
  const result: ReturnType<typeof parseArgs> = { text: "" };
  const textParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = args[index + 1];
    if (value === "--username" && next) {
      result.username = next.replace(/^@/, "");
      index += 1;
    } else if (value === "--user-id" && next) {
      result.userId = next;
      index += 1;
    } else if (value === "--context-text" && next) {
      result.contextText = next;
      index += 1;
    } else if (value === "--context-username" && next) {
      result.contextUsername = next.replace(/^@/, "");
      index += 1;
    } else {
      textParts.push(value);
    }
  }

  result.text = textParts.join(" ").trim();
  return result;
}
