import type { Env } from "../env";
import { getJobberAccessToken } from "./tokens";
import { fetchWithRetry, PermanentError, RetryableError } from "../util/retry";
import { log, snippet } from "../log";

export const JOBBER_GRAPHQL_URL = "https://api.getjobber.com/api/graphql";

/**
 * Visit + parent Job details. Field names are from the published schema in the Developer Center
 * (type Visit / Job / Property / Client / User). Connection is paginated (`first`) to keep query cost low.
 * Keep in sync with graphql/visit-for-calendar.graphql.
 */
export const VISIT_QUERY = /* GraphQL */ `
  query VisitForCalendar($id: EncodedId!) {
    visit(id: $id) {
      __typename
      id
      title
      startAt
      endAt
      allDay
      instructions
      visitStatus
      isComplete
      job {
        __typename
        id
        jobNumber
        title
        jobberWebUri
      }
      client {
        id
        name
      }
      property {
        id
        address {
          street1
          street2
          city
          province
          postalCode
          country
        }
      }
      assignedUsers(first: 25) {
        nodes {
          id
          name {
            full
          }
        }
      }
    }
  }
`;

/** Visit IDs of one Job (used for JOB_CREATE). Paginated; capped by MAX_JOB_VISITS in the processor. */
export const JOB_VISITS_QUERY = /* GraphQL */ `
  query JobVisits($id: EncodedId!, $first: Int!, $after: String) {
    job(id: $id) {
      id
      visits(first: $first, after: $after) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const USERS_QUERY = /* GraphQL */ `
  query JobberUsers($first: Int!) {
    users(first: $first) {
      nodes {
        id
        name {
          full
        }
      }
    }
  }
`;

export const ACCOUNT_QUERY = /* GraphQL */ `
  query GetAccount {
    account {
      id
      name
    }
  }
`;

export interface JobberUserRef {
  id: string;
  name?: { full?: string | null } | null;
}

export interface JobberVisit {
  __typename?: string;
  id: string;
  title: string | null;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  instructions: string | null;
  visitStatus: string;
  isComplete: boolean;
  job: { __typename?: string; id: string; jobNumber: number | null; title: string | null; jobberWebUri: string | null } | null;
  client: { id: string; name: string | null } | null;
  property: {
    id: string;
    address: {
      street1?: string | null;
      street2?: string | null;
      city?: string | null;
      province?: string | null;
      postalCode?: string | null;
      country?: string | null;
    } | null;
  } | null;
  assignedUsers: { nodes: JobberUserRef[] } | null;
}

interface GraphQLError {
  message: string;
  extensions?: { code?: string };
}

const NOT_FOUND = /not\s*found|could not find|does not exist|couldn't find/i;

/**
 * POSTs a GraphQL operation for one Jobber account.
 * - 401 -> forces one token refresh and retries.
 * - HTTP 429 / 5xx -> retried inline, then RetryableError (queue retries later).
 * - errors[].extensions.code === "THROTTLED" -> RetryableError with a wait derived from the cost bucket.
 * - "not found" errors with a null result -> returns data so callers can treat the record as gone.
 */
export async function jobberGraphQL<T>(env: Env, accountId: string, query: string, variables: Record<string, unknown> = {}, accessToken?: string): Promise<T> {
  let forced = false;
  let token = accessToken ?? (await getJobberAccessToken(env, accountId));

  for (;;) {
    const res = await fetchWithRetry(
      JOBBER_GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "X-JOBBER-GRAPHQL-VERSION": env.JOBBER_API_VERSION,
        },
        body: JSON.stringify({ query, variables }),
      },
      { label: "jobber.graphql" },
    );

    if (res.status === 401 && !forced && !accessToken) {
      forced = true;
      await res.body?.cancel();
      token = await getJobberAccessToken(env, accountId, { forceRefresh: true });
      continue;
    }
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`Jobber GraphQL HTTP ${res.status}`);
    if (!res.ok) throw new PermanentError(`Jobber GraphQL HTTP ${res.status}: ${snippet(text, 200)}`);

    const body = JSON.parse(text) as {
      data?: T;
      errors?: GraphQLError[];
      extensions?: {
        versioning?: { version?: string; warning?: string };
        cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } };
      };
    };

    const versionWarning = body.extensions?.versioning?.warning;
    if (versionWarning) log("warn", "Jobber API version warning", { warning: versionWarning });

    if (body.errors?.length) {
      if (body.errors.some((e) => e.extensions?.code === "THROTTLED")) {
        const c = body.extensions?.cost;
        const deficit = (c?.requestedQueryCost ?? 0) - (c?.throttleStatus?.currentlyAvailable ?? 0);
        const wait = Math.ceil(Math.max(deficit, 0) / Math.max(c?.throttleStatus?.restoreRate ?? 500, 1)) + 1;
        throw new RetryableError("Jobber GraphQL throttled", wait);
      }
      if (body.data && body.errors.every((e) => NOT_FOUND.test(e.message))) return body.data;
      log("error", "Jobber GraphQL errors", { errors: body.errors.map((e) => e.message) });
      throw new PermanentError(`Jobber GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    if (!body.data) throw new RetryableError("Jobber GraphQL returned no data");
    return body.data;
  }
}
