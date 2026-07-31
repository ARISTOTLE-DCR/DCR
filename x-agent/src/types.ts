export type MentionContextPost = {
  id: string;
  text: string;
  authorId?: string;
  username?: string;
};

export type Mention = {
  id: string;
  text: string;
  authorId: string;
  username?: string;
  contextPost?: MentionContextPost;
  images?: Array<{
    url: string;
    altText?: string;
  }>;
};
