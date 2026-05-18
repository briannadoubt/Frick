import type { FrickErrorEnvelope, PlainObject } from "@frick/protocol";

export type AnalyticsAttributes = Record<string, string | number | boolean>;
type FetchImpl = (input: URL, init?: RequestInit) => Promise<Response>;

export interface AnalyticsTrackOptions {
  properties?: PlainObject;
  context?: PlainObject;
  attributes?: AnalyticsAttributes;
  traceId?: string;
  idempotencyKey?: string;
  occurredAt?: string | Date;
}

export interface TrackAnalyticsEventInput extends AnalyticsTrackOptions {
  httpEndpoint: string;
  sessionToken?: string | undefined;
  name: string;
  fetchImpl?: FetchImpl | undefined;
}

export interface AnalyticsTrackReceipt {
  ok: true;
  eventId: string;
  sequence: number;
  acceptedAt: string;
  duplicate: boolean;
}

export async function trackAnalyticsEvent({
  httpEndpoint,
  sessionToken,
  name,
  properties,
  context,
  attributes,
  traceId,
  idempotencyKey,
  occurredAt,
  fetchImpl = fetch,
}: TrackAnalyticsEventInput): Promise<AnalyticsTrackReceipt> {
  const response = await fetchImpl(frickHttpUrl(httpEndpoint, "analytics/events"), {
    method: "POST",
    headers: authorizedJsonHeaders(sessionToken),
    body: JSON.stringify(
      withoutUndefined({
        name,
        properties,
        context,
        attributes,
        traceId,
        idempotencyKey,
        occurredAt: occurredAt instanceof Date ? occurredAt.toISOString() : occurredAt,
      }),
    ),
  });

  if (!response.ok) {
    throw new Error(await analyticsErrorMessage(response));
  }

  return (await response.json()) as AnalyticsTrackReceipt;
}

function frickHttpUrl(httpEndpoint: string, path: string): URL {
  const baseUrl = `${httpEndpoint.replace(/\/$/, "")}/`;
  return new URL(path.replace(/^\/+/, ""), baseUrl);
}

function authorizedJsonHeaders(sessionToken: string | undefined): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  };
}

async function analyticsErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as FrickHttpErrorBody | unknown;
    if (body && typeof body === "object") {
      const error = "error" in body ? body.error : undefined;
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
        return error.message;
      }
      if ("message" in body && typeof body.message === "string") {
        return body.message;
      }
    }
  } catch {
    // Fall back to the status line when the server did not return JSON.
  }
  return `Analytics request returned ${response.status}`;
}

interface FrickHttpErrorBody {
  error?: FrickErrorEnvelope;
  message?: string;
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}
