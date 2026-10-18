import type { Env } from "../env";
import { getGoogleAccessToken, resetGoogleTokenCache } from "./auth";
import { fetchWithRetry, PermanentError, RetryableError } from "../util/retry";
import { log, snippet } from "../log";

export const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

export type GEventTime = { dateTime: string; timeZone?: string } | { date: string };

export interface GEvent {
  id: string;
  summary: string;
  location?: string;
  description?: string;
  start: GEventTime;
  end: GEventTime;
  status: "confirmed";
  transparency: "opaque"; // shows as busy -> blocks availability in Routemize
  extendedProperties: { private: Record<string, string> };
  source?: { title: string; url: string };
  reminders: { useDefault: boolean };
}

function eventUrl(calendarId: string, eventId?: string): string {
  const base = `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

async function gcal(env: Env, method: string, url: string, body?: unknown): Promise<{ status: number; text: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getGoogleAccessToken(env);
    const res = await fetchWithRetry(
      `${url}${url.includes("?") ? "&" : "?"}sendUpdates=none`,
      {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { label: `google.calendar.${method.toLowerCase()}` },
    );
    const text = await res.text();
    if (res.status === 401 && attempt === 0) {
      resetGoogleTokenCache();
      continue;
    }
    if (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(text)) {
      throw new RetryableError("Google Calendar rate limited", 30);
    }
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`Google Calendar HTTP ${res.status}`);
    return { status: res.status, text };
  }
  throw new PermanentError("Google Calendar rejected credentials after refresh");
}

/**
 * Idempotent create-or-update with a deterministic event ID:
 *   PUT (update)  -> 200 updated (also revives an event previously deleted/cancelled with this ID)
 *   404           -> POST (insert) with our ID -> created
 *   409 on insert -> someone created it in between -> PUT again
 */
export async function upsertCalendarEvent(env: Env, calendarId: string, event: GEvent): Promise<"created" | "updated"> {
  const put = await gcal(env, "PUT", eventUrl(calendarId, event.id), event);
  if (put.status === 200) return "updated";
  if (put.status !== 404) throw calendarError("update", calendarId, put);

  const ins = await gcal(env, "POST", eventUrl(calendarId), event);
  if (ins.status === 200) return "created";
  if (ins.status === 409) {
    const retry = await gcal(env, "PUT", eventUrl(calendarId, event.id), event);
    if (retry.status === 200) return "updated";
    throw calendarError("update", calendarId, retry);
  }
  throw calendarError("insert", calendarId, ins);
}

/** Delete; 404/410 count as already gone. */
export async function deleteCalendarEvent(env: Env, calendarId: string, eventId: string): Promise<"deleted" | "already_gone"> {
  const res = await gcal(env, "DELETE", eventUrl(calendarId, eventId));
  if (res.status === 204 || res.status === 200) return "deleted";
  if (res.status === 404 || res.status === 410) return "already_gone";
  throw calendarError("delete", calendarId, res);
}

function calendarError(op: string, calendarId: string, r: { status: number; text: string }): Error {
  log("error", "Google Calendar API error", { op, calendarId, status: r.status, response: snippet(r.text, 300) });
  // 403/404 here mean the calendar isn't shared with our identity (or doesn't exist): a config problem.
  return new PermanentError(`Google Calendar ${op} failed on ${calendarId}: HTTP ${r.status}`);
}
