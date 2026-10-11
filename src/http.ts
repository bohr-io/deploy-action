export type Fetch = typeof fetch;
export type Sleep = (ms: number) => Promise<void>;

/** Total attempts per request: the first try plus retries after 1s, 2s, 4s and 8s. */
export const MAX_ATTEMPTS = 5;
/** Upper bound for a Retry-After wait, so a bogus header cannot stall the job. */
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface RetryOptions {
  fetch: Fetch;
  sleep?: Sleep;
  /** Receives one line per retry, for the job log. */
  onRetry?: (message: string) => void;
  attempts?: number;
  /** Per-attempt timeout; a timed-out attempt counts as a network error. */
  timeoutMs?: number;
}

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Parses a Retry-After header (delay in seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Sends a request, retrying network errors, 429 and 5xx with exponential backoff
 * (1s, 2s, 4s, 8s) or the server's Retry-After. Resolves with the first
 * non-retryable response, or the last response once attempts run out; rejects
 * when the last attempt failed at the network level. The body must be
 * re-readable (string, Uint8Array, Blob or FormData).
 */
export async function fetchWithRetry(url: string, init: RequestInit, options: RetryOptions): Promise<Response> {
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await options.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      failure = error;
    }
    if (response && !isRetryableStatus(response.status)) return response;
    if (attempt >= attempts) {
      if (response) return response;
      throw new Error(`Request to ${describeUrl(url)} failed after ${attempts} attempts: ${errorMessage(failure)}`);
    }

    const retryAfter = response ? parseRetryAfter(response.headers.get('retry-after')) : undefined;
    const delay = Math.min(retryAfter ?? 1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
    const reason = response ? `HTTP ${response.status}` : errorMessage(failure);
    await response?.body?.cancel().catch(() => {});
    options.onRetry?.(
      `${describeUrl(url)}: ${reason}; retrying in ${delay / 1000}s (attempt ${attempt + 1} of ${attempts}).`,
    );
    await sleep(delay);
  }
}

/** Message of an error, including the cause undici attaches to "fetch failed". */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message} (${cause.message})`;
  }
  return error.message;
}

/** Host and path of a URL, for log lines. */
function describeUrl(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    return `${host}${pathname}`;
  } catch {
    return url;
  }
}
