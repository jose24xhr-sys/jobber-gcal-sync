import type { Env, SyncMessage } from "../env";
import * as repo from "../db/repo";
import { classifyTopic } from "../config";
import { jobberGraphQL, VISIT_QUERY, type JobberVisit } from "../jobber/graphql";
import { isDefinitelyNot } from "../jobber/ids";
import { deleteCalendarEvent, upsertCalendarEvent } from "../google/calendar";
import { buildEventBody, contentHash, deterministicEventId } from "./mapEvent";
import { validateJobVisit } from "./validate";
import { log } from "../log";

export type SyncAction = "created" | "updated" | "deleted" | "noop" | "skipped";

interface Ctx {
  env: Env;
  topic: string;
  accountId: string;
}

async function record(ctx: Ctx, fields: { action: SyncAction | "error"; itemId?: string; jobId?: string; userId?: string; calendarId?: string; reason?: string; detail?: unknown }) {
  const level = fields.action === "error" ? "error" : "info";
  log(level, `sync ${fields.action}`, {
    topic: ctx.topic,
    accountId: ctx.accountId,
    visitId: fields.itemId,
    jobId: fields.jobId,
    assignedUser: fields.userId,
    calendarId: fields.calendarId,
    reason: fields.reason,
    detail: fields.detail,
  });
  await repo.writeSyncLog(ctx.env.DB, {
    at: Date.now(),
    topic: ctx.topic,
    accountId: ctx.accountId,
    itemId: fields.itemId,
    jobId: fields.jobId,
    action: fields.action,
    detail: { reason: fields.reason, userId: fields.userId, calendarId: fields.calendarId, ...(fields.detail as object | undefined) },
  });
}

/** Entry point for one queue message. Throws RetryableError / PermanentError for the queue handler. */
export async function processMessage(env: Env, msg: SyncMessage): Promise<void> {
  const ctx: Ctx = { env, topic: msg.topic, accountId: msg.accountId };
  const kind = classifyTopic(msg.topic, env);

  switch (kind) {
    case "ignored":
      await record(ctx, { action: "skipped", itemId: msg.itemId, reason: "Skipped non-job event" });
      return;

    case "app_disconnect":
      await repo.setAccountStatus(env.DB, msg.accountId, "disconnected", Date.now());
      await record(ctx, { action: "skipped", itemId: msg.itemId, reason: "Jobber app disconnected; tokens disabled" });
      return;

    case "visit_upsert":
      if (isDefinitelyNot(msg.itemId, "Visit")) {
        await record(ctx, { action: "skipped", itemId: msg.itemId, reason: "Skipped non-job event" });
        return;
      }
      await syncVisit(ctx, msg.itemId);
      return;

    case "visit_delete":
      if (isDefinitelyNot(msg.itemId, "Visit")) {
        await record(ctx, { action: "skipped", itemId: msg.itemId, reason: "Skipped non-job event" });
        return;
      }
      await removeVisit(ctx, msg.itemId, "visit deleted in Jobber");
      return;

    case "job_update": {
      // Job title/property/assignment edits may not fire per-visit webhooks; re-sync visits we track.
      const visitIds = await repo.listVisitIdsForJob(env.DB, msg.accountId, msg.itemId);
      for (const id of visitIds) await syncVisit(ctx, id);
      if (visitIds.length === 0) await record(ctx, { action: "noop", jobId: msg.itemId, reason: "no tracked visits for job" });
      return;
    }

    case "job_delete": {
      const visitIds = await repo.listVisitIdsForJob(env.DB, msg.accountId, msg.itemId);
      for (const id of visitIds) await removeVisit(ctx, id, "parent job deleted in Jobber");
      return;
    }
  }
}

/** Fetch current state from Jobber and make Google match it. Order-independent and idempotent. */
export async function syncVisit(ctx: Ctx, visitId: string): Promise<void> {
  const { env, accountId } = ctx;
  const data = await jobberGraphQL<{ visit: JobberVisit | null }>(env, accountId, VISIT_QUERY, { id: visitId });
  const result = validateJobVisit(data.visit);
  const existing = await repo.listVisitEvents(env.DB, accountId, visitId);

  if (!result.ok) {
    await record(ctx, { action: "skipped", itemId: visitId, jobId: data.visit?.job?.id, reason: result.message });
    // A visit that stopped qualifying (unscheduled, unassigned, gone) must not keep blocking calendars.
    if (existing.length > 0 && result.reason !== "non_job_object") {
      await removeVisit(ctx, visitId, `no longer a scheduled job visit (${result.reason})`, existing);
    }
    return;
  }

  const visit = result.visit;
  const calendars = await repo.getCalendarsForUsers(env.DB, accountId, visit.users.map((u) => u.id));
  const desired = new Map<string, string>(); // jobberUserId -> calendarId
  for (const u of visit.users) {
    const cal = calendars.get(u.id);
    if (cal) desired.set(u.id, cal);
    else await record(ctx, { action: "skipped", itemId: visitId, jobId: visit.job.id, userId: u.id, reason: `No calendar mapping for Jobber user ${u.name?.full ?? u.id}` });
  }

  // 1) Reassignment / calendar change: remove events from calendars that should no longer have them.
  for (const row of existing) {
    const target = desired.get(row.jobber_user_id);
    if (target === row.google_calendar_id) continue;
    const r = await deleteCalendarEvent(env, row.google_calendar_id, row.google_event_id);
    await repo.deleteVisitEvent(env.DB, accountId, visitId, row.jobber_user_id);
    await record(ctx, { action: "deleted", itemId: visitId, jobId: row.job_id, userId: row.jobber_user_id, calendarId: row.google_calendar_id, reason: target ? "calendar mapping changed" : "user unassigned", detail: { google: r } });
  }

  // 2) Create/update one event per mapped assigned user.
  for (const [userId, calendarId] of desired) {
    const eventId = await deterministicEventId(accountId, visitId, userId);
    const event = buildEventBody(env, accountId, visit, userId, eventId);
    const hash = await contentHash(calendarId, event);
    const prev = existing.find((r) => r.jobber_user_id === userId && r.google_calendar_id === calendarId);
    if (prev?.content_hash === hash) {
      await record(ctx, { action: "noop", itemId: visitId, jobId: visit.job.id, userId, calendarId, reason: "unchanged (duplicate webhook)" });
      continue;
    }

    const row: repo.VisitEventRow = {
      account_id: accountId,
      visit_id: visitId,
      jobber_user_id: userId,
      job_id: visit.job.id,
      google_calendar_id: calendarId,
      google_event_id: eventId,
      content_hash: null,
      last_synced_at: Date.now(),
    };
    // Persist the mapping BEFORE writing to Google, so a later delete can always find the event.
    await repo.upsertVisitEvent(env.DB, row);
    const outcome = await upsertCalendarEvent(env, calendarId, event);
    await repo.upsertVisitEvent(env.DB, { ...row, content_hash: hash, last_synced_at: Date.now() });
    await record(ctx, { action: outcome, itemId: visitId, jobId: visit.job.id, userId, calendarId, detail: { eventId, startAt: visit.startAt, endAt: visit.endAt } });
  }
}

/** Delete every event we created for a visit, using stored mappings (the Visit may no longer exist in Jobber). */
export async function removeVisit(ctx: Ctx, visitId: string, reason: string, rows?: repo.VisitEventRow[]): Promise<void> {
  const { env, accountId } = ctx;
  const existing = rows ?? (await repo.listVisitEvents(env.DB, accountId, visitId));
  if (existing.length === 0) {
    await record(ctx, { action: "noop", itemId: visitId, reason: `${reason}; nothing to delete` });
    return;
  }
  for (const row of existing) {
    const r = await deleteCalendarEvent(env, row.google_calendar_id, row.google_event_id);
    await repo.deleteVisitEvent(env.DB, accountId, visitId, row.jobber_user_id);
    await record(ctx, { action: "deleted", itemId: visitId, jobId: row.job_id, userId: row.jobber_user_id, calendarId: row.google_calendar_id, reason, detail: { google: r } });
  }
}
