import { TwitterApi } from "twitter-api-v2";
import { loadXAuthConfig } from "../config.js";

const config = loadXAuthConfig();
const client =
  config.X_ACCESS_TOKEN && config.X_ACCESS_SECRET
    ? new TwitterApi({
        appKey: config.X_API_KEY,
        appSecret: config.X_API_SECRET,
        accessToken: config.X_ACCESS_TOKEN,
        accessSecret: config.X_ACCESS_SECRET
      })
    : new TwitterApi(config.X_OAUTH2_ACCESS_TOKEN!);

const me = await client.v2.me({
  "user.fields": ["username", "name"]
});

console.log(`BOT_USER_ID=${me.data.id}`);
console.log(`BOT_HANDLE=${me.data.username}`);
