import { readFile } from 'node:fs/promises';
import { NULL_CONTENT_TYPE } from './hash';
import { type Fetch, fetchWithRetry, type RetryOptions, type Sleep } from './http';
import type { AssetFile } from './manifest';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** Buckets uploaded in parallel, as wrangler does. */
export const BUCKET_CONCURRENCY = 3;
/** Parallel single-file uploads when the token does not say otherwise (wrangler's default). */
export const SINGLE_UPLOAD_CONCURRENCY = 50;

export interface UploadOptions {
  accountId: string;
  /** JWT from the deploy session; it only allows uploading to that session. */
  uploadToken: string;
  /** Hashes to upload, grouped by the instance (Cloudflare) into buckets. */
  buckets: readonly (readonly string[])[];
  /** Manifest files; looked up by hash. */
  files: readonly AssetFile[];
  fetch: Fetch;
  sleep?: Sleep;
  log?: (message: string) => void;
  apiBase?: string;
}

export interface UploadResult {
  completionToken: string;
  uploadedFiles: number;
  uploadedBytes: number;
  singleAssetUploads: boolean;
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

/** Decodes a JWT payload without verifying it; undefined when it is not a JWT. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Uploads the requested assets straight to Cloudflare and returns the
 * completion token the finalize step needs. Uses bucket uploads (multipart,
 * base64) unless the upload token asks for single-asset uploads, like wrangler.
 */
export async function uploadAssets(options: UploadOptions): Promise<UploadResult> {
  const byHash = new Map<string, AssetFile>();
  for (const file of options.files) {
    if (!byHash.has(file.hash)) byHash.set(file.hash, file);
  }
  const buckets = options.buckets
    .map((bucket) =>
      bucket.map((hash) => {
        const file = byHash.get(hash);
        if (!file) throw new Error(`The bohr instance asked for an asset that is not in the manifest (hash ${hash}).`);
        return file;
      }),
    )
    .filter((bucket) => bucket.length > 0);

  const claims = decodeJwtPayload(options.uploadToken);
  const single = claims?.wrangler_single_asset_uploads === true;
  const jobs = single ? buckets.flat().map((file) => [file]) : buckets;
  const total = jobs.reduce((count, job) => count + job.length, 0);
  if (total === 0) {
    return { completionToken: options.uploadToken, uploadedFiles: 0, uploadedBytes: 0, singleAssetUploads: single };
  }

  const base = `${options.apiBase ?? CLOUDFLARE_API}/accounts/${encodeURIComponent(options.accountId)}/workers/assets/upload`;
  const authorization = `Bearer ${options.uploadToken}`;
  const retry: RetryOptions = { fetch: options.fetch, sleep: options.sleep, onRetry: options.log };
  const concurrency = single ? singleUploadConcurrency(claims) : BUCKET_CONCURRENCY;
  const logEvery = single ? Math.max(1, Math.ceil(total / 10)) : 1;

  let completionToken = '';
  let uploadedFiles = 0;
  let uploadedBytes = 0;
  let jobsDone = 0;

  await runConcurrently(jobs, concurrency, async (job) => {
    let response: Response;
    if (single) {
      const file = job[0] as AssetFile;
      response = await fetchWithRetry(
        `${base}/${file.hash}`,
        {
          method: 'POST',
          headers: { Authorization: authorization, 'Content-Type': file.contentType ?? NULL_CONTENT_TYPE },
          body: new Uint8Array(await readFile(file.absolutePath)),
        },
        retry,
      );
    } else {
      // Read the bucket only when uploading it, to bound memory use.
      const form = new FormData();
      for (const file of job) {
        const base64 = (await readFile(file.absolutePath)).toString('base64');
        form.append(
          file.hash,
          new File([base64], file.hash, { type: file.contentType ?? NULL_CONTENT_TYPE }),
          file.hash,
        );
      }
      response = await fetchWithRetry(
        `${base}?base64=true`,
        { method: 'POST', headers: { Authorization: authorization }, body: form },
        retry,
      );
    }

    const jwt = await readUploadResponse(response);
    if (jwt) completionToken = jwt;
    uploadedFiles += job.length;
    uploadedBytes += job.reduce((bytes, file) => bytes + file.size, 0);
    jobsDone++;
    if (jobsDone % logEvery === 0 || uploadedFiles === total) {
      options.log?.(`Uploaded ${uploadedFiles} of ${total} files`);
    }
  });

  if (!completionToken) {
    throw new Error(
      'Cloudflare did not return an assets completion token. Run the workflow again; files already uploaded are kept.',
    );
  }
  return { completionToken, uploadedFiles, uploadedBytes, singleAssetUploads: single };
}

interface CloudflareEnvelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: { jwt?: unknown } | null;
}

/** Checks a Cloudflare API response and returns `result.jwt` when present. */
async function readUploadResponse(response: Response): Promise<string | undefined> {
  const text = await response.text();
  let body: CloudflareEnvelope | undefined;
  try {
    body = JSON.parse(text) as CloudflareEnvelope;
  } catch {
    body = undefined;
  }
  if (!response.ok || !body || body.success === false) {
    const details = body?.errors?.length
      ? body.errors
          .map((error) => `${error.message ?? 'unknown error'}${error.code ? ` [code ${error.code}]` : ''}`)
          .join('; ')
      : text.trim().slice(0, 300) || response.statusText || 'no details';
    const hint =
      response.status === 401 || response.status === 403
        ? '\nThe upload token was rejected; it is short-lived, so run the workflow again.'
        : '';
    throw new CloudflareApiError(
      `Cloudflare asset upload failed (HTTP ${response.status}): ${details}${hint}`,
      response.status,
    );
  }
  const jwt = body.result?.jwt;
  return typeof jwt === 'string' && jwt !== '' ? jwt : undefined;
}

function singleUploadConcurrency(claims: Record<string, unknown> | undefined): number {
  const value = Number(claims?.edge_kv_upload_concurrency);
  return value > 0 ? Math.floor(value) : SINGLE_UPLOAD_CONCURRENCY;
}

/** Runs tasks with at most `limit` in flight; stops starting new ones after the first failure. */
async function runConcurrently<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await task(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
