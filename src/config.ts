import type { Env } from "./env";

/**
 * Jobber topics follow OBJECT_ACTION (docs: "Setting up Webhooks"). The full list lives in the
 * Developer Center and in WebHookTopicEnum. Defaults below are the Visit/Job lifecycle topics;
 * override with ALLOWED_TOPICS if your Developer Center shows different names.
 */
export const DEFAULT_ALLOWED_TOPICS = [
  "VISIT_CREATE",
  "VISIT_UPDATE",
  "VISIT_COMPLETE",
  "VISIT_DESTROY",
  "JOB_UPDATE",
  "JOB_DESTROY",
  "APP_DISCONNECT",
];

export type TopicKind =
  | "visit_upsert"
  | "visit_delete"
  | "job_update"
  | "job_delete"
  | "app_disconnect"
  | "ignored";

const DELETE_ACTIONS = new Set(["DESTROY", "DELETE", "DESTROYED", "DELETED"]);

export function allowedTopics(env: Pick<Env, "ALLOWED_TOPICS">): Set<string> {
  const raw = env.ALLOWED_TOPICS?.trim();
  const list = raw ? raw.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) : DEFAULT_ALLOWED_TOPICS;
  return new Set(list);
}

/**
 * Classifies a topic. Only VISIT_*, JOB_* and APP_DISCONNECT can ever do work, and only if allow-listed.
 * REQUEST_*, QUOTE_*, ASSESSMENT_*, INVOICE_*, CLIENT_*, etc. are always "ignored".
 */
export function classifyTopic(topic: string, env: Pick<Env, "ALLOWED_TOPICS">): TopicKind {
  const t = topic.toUpperCase();
  if (!allowedTopics(env).has(t)) return "ignored";
  if (t === "APP_DISCONNECT") return "app_disconnect";
  const [object, ...rest] = t.split("_");
  const action = rest.join("_");
  if (object === "VISIT") return DELETE_ACTIONS.has(action) ? "visit_delete" : "visit_upsert";
  if (object === "JOB") return DELETE_ACTIONS.has(action) ? "job_delete" : "job_update";
  return "ignored";
}
