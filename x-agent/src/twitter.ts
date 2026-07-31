import { readFile, writeFile } from "node:fs/promises";
import { TwitterApi, type TTweetv2Expansion, type TTweetv2MediaField, type TTweetv2TweetField, type TTweetv2UserField } from "twitter-api-v2";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import type { Mention } from "./types.js";
import { compareSnowflakes, maxSnowflake } from "./state.js";

type MentionPaginator = Awaited<ReturnType<TwitterApi["v2"]["userMentionTimeline"]>>;

export class TwitterClient {
  private readonly readClient: TwitterApi;
  private readonly oauth1WriteClient?: TwitterApi;
  private oauth2WriteClient?: TwitterApi;
  private oauth2AccessToken?: string;
  private oauth2RefreshToken?: string;

  constructor(private readonly config: AppConfig) {
    this.readClient = new TwitterApi(config.X_BEARER_TOKEN);
    if (config.X_ACCESS_TOKEN && config.X_ACCESS_SECRET) {
      this.oauth1WriteClient = new TwitterApi({
        appKey: config.X_API_KEY,
        appSecret: config.X_API_SECRET,
        accessToken: config.X_ACCESS_TOKEN,
        accessSecret: config.X_ACCESS_SECRET
      });
    }
    this.oauth2AccessToken = config.X_OAUTH2_ACCESS_TOKEN;
    this.oauth2RefreshToken = config.X_OAUTH2_REFRESH_TOKEN;
  }

  async getMentions(sinceId?: string): Promise<{ mentions: Mention[]; newestId?: string }> {
    const expansions: TTweetv2Expansion[] = ["author_id", "referenced_tweets.id", "referenced_tweets.id.author_id", "attachments.media_keys"];
    const tweetFields: TTweetv2TweetField[] = ["author_id", "created_at", "referenced_tweets", "attachments"];
    const mediaFields: TTweetv2MediaField[] = ["type", "url", "preview_image_url", "alt_text"];
    const userFields: TTweetv2UserField[] = ["username"];
    const commonParams = {
      max_results: this.config.MENTION_LOOKBACK_LIMIT,
      since_id: sinceId,
      expansions,
      "tweet.fields": tweetFields,
      "user.fields": userFields,
      "media.fields": mediaFields
    };

    const mentionRequest = this.readClient.v2.userMentionTimeline(this.config.BOT_USER_ID, commonParams);
    const searchRequest = this.readClient.v2.search(`@${this.config.BOT_HANDLE} -is:retweet`, {
      ...commonParams,
      max_results: Math.max(10, Math.min(100, this.config.MENTION_LOOKBACK_LIMIT))
    });

    const results = await Promise.allSettled([mentionRequest, searchRequest]);
    const paginators = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [result.value];
      logger.warn(index === 0 ? "Mention timeline request failed" : "Mention search fallback failed", { error: result.reason });
      return [];
    });
    if (paginators.length === 0) throw new Error("Could not fetch mentions from timeline or search.");

    const mentions = dedupeMentions(paginators.flatMap((paginator) => this.mapMentionPaginator(paginator as MentionPaginator))).sort((a, b) => compareSnowflakes(a.id, b.id));
    const newestId = maxSnowflake(paginators.map((paginator) => paginator.meta?.newest_id));
    return { mentions, newestId };
  }

  async reply(tweetId: string, text: string): Promise<void> {
    const client = await this.getWriteClient();
    try {
      await client.v2.reply(text, tweetId);
    } catch (error) {
      if (!this.canRefreshOAuth2(error)) throw error;
      const refreshedClient = await this.refreshOAuth2WriteClient();
      await refreshedClient.v2.reply(text, tweetId);
    }
  }

  private mapMentionPaginator(paginator: MentionPaginator): Mention[] {
    return paginator.tweets
      .filter((tweet) => tweet.author_id && tweet.author_id !== this.config.BOT_USER_ID)
      .map((tweet) => {
        const author = paginator.includes.author(tweet);
        const repliedTo = paginator.includes.repliedTo(tweet);
        const repliedToAuthor = repliedTo ? paginator.includes.author(repliedTo) : undefined;
        const images = paginator.includes.medias(tweet)
          .filter((media) => media.type === "photo")
          .flatMap((media) => {
            const url = media.url ?? media.preview_image_url;
            return url ? [{ url, altText: media.alt_text }] : [];
          });

        return {
          id: tweet.id,
          text: tweet.text,
          authorId: tweet.author_id!,
          username: author?.username,
          images,
          contextPost: repliedTo
            ? {
                id: repliedTo.id,
                text: repliedTo.text,
                authorId: repliedTo.author_id,
                username: repliedToAuthor?.username
              }
            : undefined
        };
      });
  }

  private async getWriteClient(): Promise<TwitterApi> {
    if (this.oauth1WriteClient) return this.oauth1WriteClient;
    if (this.oauth2WriteClient) return this.oauth2WriteClient;

    const saved = await this.loadSavedOAuth2Tokens();
    this.oauth2AccessToken = saved?.accessToken ?? this.oauth2AccessToken;
    this.oauth2RefreshToken = saved?.refreshToken ?? this.oauth2RefreshToken;

    if (this.oauth2AccessToken) {
      this.oauth2WriteClient = new TwitterApi(this.oauth2AccessToken);
      return this.oauth2WriteClient;
    }

    return this.refreshOAuth2WriteClient();
  }

  private async refreshOAuth2WriteClient(): Promise<TwitterApi> {
    if (!this.config.X_OAUTH2_CLIENT_ID || !this.oauth2RefreshToken) {
      throw new Error("OAuth2 access token expired, but X_OAUTH2_CLIENT_ID and X_OAUTH2_REFRESH_TOKEN are not configured.");
    }

    const requestClient = new TwitterApi({
      clientId: this.config.X_OAUTH2_CLIENT_ID,
      clientSecret: this.config.X_OAUTH2_CLIENT_SECRET
    });
    const result = await requestClient.refreshOAuth2Token(this.oauth2RefreshToken);
    this.oauth2WriteClient = result.client;
    this.oauth2AccessToken = result.accessToken;
    this.oauth2RefreshToken = result.refreshToken ?? this.oauth2RefreshToken;
    await this.saveOAuth2Tokens();
    logger.info("Refreshed OAuth2 X token");
    return this.oauth2WriteClient;
  }

  private async loadSavedOAuth2Tokens(): Promise<{ accessToken?: string; refreshToken?: string } | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.config.X_OAUTH2_TOKEN_FILE, "utf8")) as {
        accessToken?: unknown;
        refreshToken?: unknown;
      };
      return {
        accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : undefined,
        refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined
      };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async saveOAuth2Tokens(): Promise<void> {
    if (!this.oauth2AccessToken) return;
    await writeFile(
      this.config.X_OAUTH2_TOKEN_FILE,
      `${JSON.stringify(
        {
          accessToken: this.oauth2AccessToken,
          refreshToken: this.oauth2RefreshToken,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`
    );
  }

  private canRefreshOAuth2(error: unknown): boolean {
    if (this.oauth1WriteClient || !this.oauth2RefreshToken) return false;
    if (typeof error !== "object" || error === null) return true;
    const code = "code" in error ? error.code : undefined;
    return code === 401 || code === 403;
  }
}

function dedupeMentions(mentions: Mention[]): Mention[] {
  const seen = new Set<string>();
  return mentions.filter((mention) => {
    if (seen.has(mention.id)) return false;
    seen.add(mention.id);
    return true;
  });
}
