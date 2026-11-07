import { z } from 'zod';
import type { Credentials } from '../../../api/src/auth/rules.js';
import { ApiError, SERVER_ERROR_CODES } from './errors.js';

// Longer than the slowest checkout the API can give: a charge and then a refund, each up to four
// 3-second attempts. A request cut short is still safe to send again with the same key.
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEALTH_TIMEOUT_MS = 5_000;
// Seat reads are polled every 2 to 3 seconds, so a stuck one is dropped well before the next.
export const SEAT_READ_TIMEOUT_MS = 10_000;

const REQUEST_ID_HEADER = 'X-Request-Id';

const MESSAGES = {
  NETWORK_ERROR: "Can't reach Taquilla. Check your connection and try again.",
  TIMEOUT: 'Taquilla took too long to answer. Try again.',
  BAD_RESPONSE: 'Something went wrong. Please try again.',
} as const;

// The error shape every API error uses (requirements.md §6.2).
const errorBody = z.object({
  error: z.object({
    code: z.enum(SERVER_ERROR_CODES),
    message: z.string(),
    seatIds: z.array(z.number().int()).optional(),
  }),
});

const healthBody = z.object({ status: z.literal('ok') });
export type Health = z.infer<typeof healthBody>;

const tokenBody = z.object({ token: z.string().min(1) });
const newFanBody = z.object({ id: z.number().int().positive(), email: z.string() });
export type NewFan = z.infer<typeof newFanBody>;

const seatState = z.enum(['available', 'held', 'sold']);
export type SeatState = z.infer<typeof seatState>;

// GET /events/:id/seats (FR-SEAT-1): every seat, in section, row and seat order.
const seatMapBody = z.object({
  event: z.object({ id: z.number().int(), name: z.string(), startsAt: z.string() }),
  seats: z.array(
    z.object({
      id: z.number().int(),
      section: z.string(),
      row: z.string(),
      number: z.number().int(),
      pricePaise: z.number().int().positive(),
      state: seatState,
    }),
  ),
});
export type SeatMapData = z.infer<typeof seatMapBody>;
export type Seat = SeatMapData['seats'][number];

// GET /events/:id/seats/states (FR-SEAT-5): the ids of the seats that aren't available.
const seatStatesBody = z.object({
  held: z.array(z.number().int()),
  sold: z.array(z.number().int()),
});
export type SeatStates = z.infer<typeof seatStatesBody>;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  // The API's address with no trailing slash, as parseWebConfig returns it.
  baseUrl: string;
  // Tests pass their own; the page uses the browser's.
  fetch?: Fetch;
  timeoutMs?: number;
  // Called when the API refuses a request's token with a 401, so the page can end the session
  // whichever call found out. Not called for a request sent without one, such as a login.
  onUnauthorized?: () => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  // Sent as JSON.
  body?: unknown;
  // Sent as a Bearer token.
  token?: string;
  idempotencyKey?: string;
  // The caller's own cancel, as when a component unmounts. It rejects with the signal's reason,
  // never with an ApiError, because nothing went wrong.
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ApiClient {
  // Resolves with the body parsed by `schema`, or rejects with an ApiError.
  request<T>(path: `/${string}`, schema: z.ZodType<T>, options?: RequestOptions): Promise<T>;
  health(signal?: AbortSignal): Promise<Health>;
  // Resolves with the fan's login token.
  logIn(credentials: Credentials): Promise<string>;
  signUp(credentials: Credentials): Promise<NewFan>;
  seatMap(eventId: number, signal?: AbortSignal): Promise<SeatMapData>;
  seatStates(eventId: number, signal?: AbortSignal): Promise<SeatStates>;
}

// Called as a plain function: a browser refuses fetch called as a method of another object.
const browserFetch: Fetch = (input, init) => fetch(input, init);

export function createApiClient({
  baseUrl,
  fetch = browserFetch,
  timeoutMs: defaultTimeoutMs = REQUEST_TIMEOUT_MS,
  onUnauthorized,
}: ApiClientOptions): ApiClient {
  async function request<T>(
    path: `/${string}`,
    schema: z.ZodType<T>,
    { method = 'GET', body, token, idempotencyKey, signal, timeoutMs }: RequestOptions = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs ?? defaultTimeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;

    let response: Response;
    let text: string;
    try {
      // The timeout covers the whole exchange, body included, so an answer that stalls halfway
      // is cut off too.
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      text = await response.text();
    } catch (err) {
      if (signal?.aborted) throw err;
      const code = timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR';
      throw new ApiError({ status: 0, code, message: MESSAGES[code], cause: err });
    }

    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    if (token !== undefined && response.status === 401) onUnauthorized?.();
    const badResponse = (cause: unknown) =>
      new ApiError({
        status: response.status,
        code: 'BAD_RESPONSE',
        message: MESSAGES.BAD_RESPONSE,
        requestId,
        cause,
      });

    let json: unknown;
    try {
      // A 204 has no body.
      json = text === '' ? undefined : JSON.parse(text);
    } catch (err) {
      throw badResponse(err);
    }

    if (!response.ok) {
      const parsed = errorBody.safeParse(json);
      if (!parsed.success) throw badResponse(parsed.error);
      const { code, message, seatIds } = parsed.data.error;
      throw new ApiError({ status: response.status, code, message, seatIds, requestId });
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) throw badResponse(parsed.error);
    return parsed.data;
  }

  return {
    request,
    health: (signal) => request('/health', healthBody, { signal, timeoutMs: HEALTH_TIMEOUT_MS }),
    logIn: async (credentials) =>
      (await request('/auth/login', tokenBody, { method: 'POST', body: credentials })).token,
    signUp: (credentials) =>
      request('/auth/signup', newFanBody, { method: 'POST', body: credentials }),
    seatMap: (eventId, signal) =>
      request(`/events/${eventId}/seats`, seatMapBody, { signal, timeoutMs: SEAT_READ_TIMEOUT_MS }),
    seatStates: (eventId, signal) =>
      request(`/events/${eventId}/seats/states`, seatStatesBody, {
        signal,
        timeoutMs: SEAT_READ_TIMEOUT_MS,
      }),
  };
}
