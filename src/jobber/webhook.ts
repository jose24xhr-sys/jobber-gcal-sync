import { hmacSha256Base64, timingSafeEqual } from "../util/crypto";

export const JOBBER_SIGNATURE_HEADER = "X-Jobber-Hmac-SHA256";

export interface JobberWebhookEvent {
  topic: string;
  appId?: string;
  accountId: string;
  itemId: string;
  occurredAt?: string;
}

/**
 * Jobber signs every webhook: header X-Jobber-Hmac-SHA256 = base64(HMAC-SHA256(client_secret, raw body)).
 * Must be computed over the exact raw bytes received, before JSON parsing.
 */
export async function verifyJobberSignature(rawBody: string, header: string | null, clientSecret: string): Promise<boolean> {
  if (!header || !clientSecret) return false;
  const expected = await hmacSha256Base64(clientSecret, rawBody);
  return timingSafeEqual(expected, header.trim());
}

/**
 * Payload: { data: { webHookEvent: { topic, appId, accountId, itemId, occurredAt } } }.
 * Apps created before 2023-12-08 receive the misspelled `occuredAt`; both are accepted.
 */
export function parseJobberWebhook(rawBody: string): JobberWebhookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const e = (parsed as { data?: { webHookEvent?: Record<string, unknown> } })?.data?.webHookEvent;
  if (!e || typeof e.topic !== "string" || typeof e.accountId !== "string" || typeof e.itemId !== "string") return null;
  const occurred = (e.occurredAt ?? e.occuredAt) as string | undefined;
  return {
    topic: e.topic,
    appId: typeof e.appId === "string" ? e.appId : undefined,
    accountId: e.accountId,
    itemId: e.itemId,
    occurredAt: typeof occurred === "string" ? occurred : undefined,
  };
}
