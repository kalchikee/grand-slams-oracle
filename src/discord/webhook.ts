import axios from 'axios';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: { text: string; icon_url?: string };
  timestamp?: string;
  thumbnail?: { url: string };
  author?: { name: string; icon_url?: string };
}

export interface WebhookPayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds: DiscordEmbed[];
}

// ─── Webhook Sender ───────────────────────────────────────────────────────────

const MAX_EMBED_DESC   = 4096;
const MAX_FIELD_VALUE  = 1024;
const MAX_FIELDS       = 25;

/** Truncate a string to Discord's limits. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

/** Send one or more embeds to a Discord webhook. */
export async function sendWebhook(
  webhookUrl: string,
  payload: WebhookPayload
): Promise<void> {
  // Discord allows max 10 embeds per message
  const BATCH_SIZE = 10;
  const embeds = payload.embeds;

  for (let i = 0; i < embeds.length; i += BATCH_SIZE) {
    const batch = embeds.slice(i, i + BATCH_SIZE);
    const body: WebhookPayload = { ...payload, embeds: batch };

    try {
      await axios.post(webhookUrl, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10_000,
      });
      // Discord rate limit: 5 requests / 2 seconds
      if (i + BATCH_SIZE < embeds.length) {
        await sleep(500);
      }
    } catch (err: any) {
      if (err?.response?.status === 429) {
        // Rate limited — wait and retry
        const retryAfter = (err.response?.data?.retry_after ?? 2) * 1000;
        console.warn(`Discord rate limited — waiting ${retryAfter}ms`);
        await sleep(retryAfter);
        await axios.post(webhookUrl, body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
        });
      } else {
        throw new Error(`Discord webhook failed: ${err?.response?.status} ${err?.message}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Get the webhook URL from env (GitHub Actions secret or local .env). */
export function getWebhookUrl(): string {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_WEBHOOK_URL environment variable not set');
  return url;
}
