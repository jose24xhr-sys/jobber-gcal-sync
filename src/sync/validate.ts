import type { JobberUserRef, JobberVisit } from "../jobber/graphql";
import { isDefinitelyNot } from "../jobber/ids";

export type SkipReason = "not_found" | "non_job_object" | "unscheduled" | "no_assigned_users";

export interface ValidJobVisit extends JobberVisit {
  startAt: string;
  endAt: string;
  job: NonNullable<JobberVisit["job"]>;
  users: JobberUserRef[];
}

export type ValidationResult = { ok: true; visit: ValidJobVisit } | { ok: false; reason: SkipReason; message: string };

/** Log messages required by the spec, keyed by reason. */
export const SKIP_MESSAGES: Record<SkipReason, string> = {
  not_found: "Skipped: visit not found (deleted or not a Visit)",
  non_job_object: "Skipped non-job event",
  unscheduled: "Skipped unscheduled job visit",
  no_assigned_users: "Skipped job visit with no assigned users",
};

/**
 * Gate run before EVERY Google Calendar write: "Is this a scheduled Visit attached to a Job?"
 *  1. it is a Visit (GraphQL __typename, and the ID doesn't decode to another type)
 *  2. it belongs to a Job (Visit.job is `Job!` in the schema; still checked defensively)
 *  3. startAt and endAt are both present (unscheduled visits have both null)
 *  4. at least one assigned user
 * Requests, Quotes and Assessments are separate types (Assessment.request: Request!) and can never pass.
 */
export function validateJobVisit(visit: JobberVisit | null | undefined): ValidationResult {
  const skip = (reason: SkipReason): ValidationResult => ({ ok: false, reason, message: SKIP_MESSAGES[reason] });

  if (!visit) return skip("not_found");
  if ((visit.__typename && visit.__typename !== "Visit") || isDefinitelyNot(visit.id, "Visit")) return skip("non_job_object");
  if (!visit.job?.id || (visit.job.__typename && visit.job.__typename !== "Job") || isDefinitelyNot(visit.job.id, "Job")) {
    return skip("non_job_object");
  }
  if (!visit.startAt || !visit.endAt) return skip("unscheduled");

  const users = (visit.assignedUsers?.nodes ?? []).filter((u): u is JobberUserRef => Boolean(u?.id));
  if (users.length === 0) return skip("no_assigned_users");

  return { ok: true, visit: { ...visit, startAt: visit.startAt, endAt: visit.endAt, job: visit.job, users } };
}
