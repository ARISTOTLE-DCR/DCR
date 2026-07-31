import "dotenv/config";
import { LaunchInterpreter } from "../launch/interpreter.js";

const request = process.argv.slice(2).join(" ").trim();
if (!request) throw new Error("Usage: npm run launch:parse -- '<launch description>'");
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
const interpreter = new LaunchInterpreter(apiKey, process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5");
console.log(JSON.stringify(await interpreter.interpret(request), null, 2));
