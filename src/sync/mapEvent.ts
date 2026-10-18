import type { Env } from "../env";
import type { GEvent, GEventTime } from "../google/calendar";
import type { ValidJobVisit } from "./validate";
import { sha256Hex } from "../util/crypto";

/**
 * Deterministic Google event ID per (account, visit, assigned user).
 * Google allows base32hex chars [a-v0-9], length 5–1024; hex digits are a subset, so "jv" + 40 hex is valid.
 * Same webhook processed twice -> same ID -> update, never a duplicate.
 */
export async function deterministicEventId(accountId: string, visitId: string, jobberUserId: string): Promise<string> {
  return `jv${(await sha256Hex(`${accountId}|${visitId}|${jobberUserId}`)).slice(0, 40)}`;
}

export function formatAddress(a: NonNullable<NonNullable<ValidJobVisit["property"]>["address"]> | null | undefined): string {
  if (!a) return "";
  const cityLine = [a.city, [a.province, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.street1, a.street2, cityLine, a.country].map((s) => s?.trim()).filter(Boolean).join(", ");
}

function localDate(iso: string, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Google all-day events use dates with an exclusive end. */
function eventTimes(visit: ValidJobVisit, tz: string): { start: GEventTime; end: GEventTime } {
  if (!visit.allDay) return { start: { dateTime: visit.startAt }, end: { dateTime: visit.endAt } };
  const startDate = localDate(visit.startAt, tz);
  const lastDay = localDate(new Date(Date.parse(visit.endAt) - 1000).toISOString(), tz);
  const endExclusive = addDays(lastDay < startDate ? startDate : lastDay, 1);
  return { start: { date: startDate }, end: { date: endExclusive } };
}

export function buildEventBody(env: Pick<Env, "DEFAULT_TIMEZONE" | "EVENT_TITLE_PREFIX">, accountId: string, visit: ValidJobVisit, jobberUserId: string, eventId: string): GEvent {
  const job = visit.job;
  const title =
    visit.title?.trim() || job.title?.trim() || (job.jobNumber != null ? `Job #${job.jobNumber}` : "Jobber visit");
  const prefix = env.EVENT_TITLE_PREFIX?.trim();
  const address = formatAddress(visit.property?.address);

  const description = [
    visit.client?.name ? `Client: ${visit.client.name}` : null,
    job.jobNumber != null ? `Job #${job.jobNumber}${job.title ? ` — ${job.title}` : ""}` : null,
    visit.instructions?.trim() ? `\nInstructions:\n${visit.instructions.trim()}` : null,
    job.jobberWebUri ? `\nOpen in Jobber: ${job.jobberWebUri}` : null,
    "\n(Synced from Jobber — edit the visit in Jobber, not here.)",
  ]
    .filter(Boolean)
    .join("\n");

  const event: GEvent = {
    id: eventId,
    summary: prefix ? `${prefix} ${title}` : title,
    location: address || undefined,
    description,
    ...eventTimes(visit, env.DEFAULT_TIMEZONE || "UTC"),
    status: "confirmed",
    transparency: "opaque",
    reminders: { useDefault: false },
    extendedProperties: {
      private: {
        source: "jobber-visit-sync",
        jobberAccountId: accountId,
        jobberVisitId: visit.id,
        jobberJobId: job.id,
        jobberUserId,
        jobberVisitStatus: visit.visitStatus ?? "",
      },
    },
  };
  if (job.jobberWebUri) event.source = { title: "Jobber", url: job.jobberWebUri };
  return event;
}

/** Hash of what we'd write; identical hash on the same calendar = nothing to do (duplicate webhook). */
export async function contentHash(calendarId: string, event: GEvent): Promise<string> {
  return sha256Hex(`${calendarId}\n${JSON.stringify(event)}`);
}
