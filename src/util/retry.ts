import { log } from "../log";

/** Temporary failure: the queue message should be retried later (with backoff). */
export class RetryableError extends Error {
  constructor(
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

/** Failure that will not fix itself (bad config, revoked auth, calendar not shared). Ack + log. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

/** Tunable so tests don't sleep. */
export const retryConfig = { baseDelayMs: 400, maxInlineWaitMs: 5000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

/**
 * Short in-request retries (jittered exponential backoff) for network errors, 429 and 5xx.
 * If the server asks for a longer wait than we're willing to spend inline, throws RetryableError
 * so the queue retries later instead. All callers send idempotent requests, so replays are safe.
 * Returns the final Response (which may still be an error status) for the caller to interpret.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { attempts?: number; label: string },
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      lastError = err;
      log("warn", "network error", { label: opts.label, attempt, error: String(err) });
      if (attempt < attempts) await sleep(backoff(attempt));
      continue;
    }
    if (!isRetryableStatus(res.status) || attempt === attempts) return res;

    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    if (retryAfter !== undefined && retryAfter * 1000 > retryConfig.maxInlineWaitMs) {
      throw new RetryableError(`${opts.label}: HTTP ${res.status}, retry after ${retryAfter}s`, retryAfter);
    }
    log("warn", "retrying request", { label: opts.label, attempt, status: res.status });
    await res.body?.cancel();
    await sleep(retryAfter !== undefined ? retryAfter * 1000 : backoff(attempt));
  }
  throw new RetryableError(`${opts.label}: network failure after ${attempts} attempts: ${String(lastError)}`);
}

function backoff(attempt: number): number {
  const base = retryConfig.baseDelayMs * 2 ** (attempt - 1);
  return base / 2 + Math.random() * (base / 2);
}

/** Queue-level backoff: 15s, 30s, 60s … capped at 15 minutes. */
export function queueBackoffSeconds(attempts: number, hint?: number): number {
  const exp = Math.min(900, 15 * 2 ** Math.max(0, attempts - 1));
  return Math.max(exp, Math.min(900, hint ?? 0));
}
