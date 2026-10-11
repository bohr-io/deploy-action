import { extname } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import mime from 'mime';

/** Content type sent for assets whose type is unknown; Cloudflare reads it as "no Content-Type". */
export const NULL_CONTENT_TYPE = 'application/null';

/**
 * Hashes an asset exactly like wrangler 4: the first 32 hex chars of
 * BLAKE3(base64(contents) + extension without the dot). Matching hashes let
 * Cloudflare skip files it already stores.
 */
export function hashAsset(contents: Uint8Array, filePath: string): string {
  const base64 = Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength).toString('base64');
  const extension = extname(filePath).slice(1);
  return bytesToHex(blake3(Buffer.from(base64 + extension, 'utf8'))).slice(0, 32);
}

/**
 * Content type of an asset as wrangler computes it: `mime` lookup by extension,
 * with `; charset=utf-8` added to text types. Null when the type is unknown.
 */
export function assetContentType(filePath: string): string | null {
  const type = mime.getType(filePath);
  if (type?.startsWith('text/') && !type.includes('charset')) {
    return `${type}; charset=utf-8`;
  }
  return type;
}
