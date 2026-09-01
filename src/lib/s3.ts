/**
 * AWS Signature Version 4, and the four S3 calls `src/lib/storage.ts` needs.
 *
 * ## Why this is hand-written rather than `@aws-sdk/client-s3`
 *
 * This repo has held a line: no dependency for anything `node:crypto` already
 * does. `scrypt` for passwords, HMAC for session and OTP signing, SHA-256 for
 * object digests — all of it is the standard library. SigV4 is the same shape
 * of problem: two HMAC chains and a canonical string. The AWS SDK for the same
 * four calls is `@aws-sdk/client-s3` plus `@aws-sdk/s3-request-presigner` and
 * their transitive tree — on the order of fifty packages and ~20 MB installed,
 * inside a Next.js server bundle that is otherwise Prisma and React. It also
 * buys a second, differently-shaped configuration surface (`forcePathStyle`,
 * credential providers, middleware stacks) for an interface that is four
 * methods wide.
 *
 * The honest cost of hand-rolling is that a SigV4 bug does not look like a bug:
 * it looks like `SignatureDoesNotMatch`, or worse, like an upload that appears
 * to work. That cost is paid down by `scripts/test-s3.mjs`, which runs this
 * module against a real S3-compatible server (MinIO in Docker) and asserts that
 * bytes put are the bytes a signed GET returns, that the digest matches, and
 * that a delete actually deletes. It is not read-and-hope.
 *
 * If a lane later needs multipart upload, bucket lifecycle management, or STS
 * credential rotation, take the SDK then. Four single-shot requests do not
 * justify it.
 *
 * ## What is deliberately not here
 *
 * No multipart. The largest object this platform stores is a 25 MB PDF and the
 * S3 single-PUT limit is 5 GB. No streaming: `put()` receives a Buffer because
 * the caller already had to buffer it to measure and hash it, and SigV4 over a
 * stream means either `aws-chunked` framing or `UNSIGNED-PAYLOAD`, both of
 * which give up the end-to-end integrity check described below.
 *
 * ## Integrity
 *
 * Every signed request carries `x-amz-content-sha256` as the hex digest of the
 * exact bytes being sent, and that header is part of the signature. S3 (and R2,
 * and MinIO) recompute it server-side and reject a mismatch. So the same digest
 * that goes onto the database row is the digest the store verified — no
 * separate checksum header needed, and no window in which the row records a
 * hash of something other than what landed.
 */
import { createHash, createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface S3Config {
  /** Origin only — `https://<account>.r2.cloudflarestorage.com`, no bucket. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Only for temporary credentials (STS / assumed roles). */
  sessionToken?: string;
  /**
   * `https://host/bucket/key` rather than `https://bucket.host/key`.
   *
   * Default true, because it is the form every S3-compatible server accepts:
   * MinIO requires it, R2 and Backblaze accept it, and AWS still honours it for
   * existing buckets. Set `S3_FORCE_PATH_STYLE=false` only if you are on AWS
   * with a bucket that requires virtual-hosted addressing.
   */
  forcePathStyle: boolean;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is unset; the s3 storage driver needs it.`);
  return value;
}

/**
 * Read the driver's configuration from the environment.
 *
 * Called lazily, per request, rather than at module load: a build must not fail
 * because a bucket has not been created yet, and `STORAGE_DRIVER=local` must
 * never require an S3 credential to exist.
 */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config {
  const endpoint = required("S3_ENDPOINT", env.S3_ENDPOINT).replace(/\/+$/, "");
  return {
    endpoint,
    region: env.S3_REGION || "auto",
    bucket: required("S3_BUCKET", env.S3_BUCKET),
    accessKeyId: required("S3_ACCESS_KEY_ID", env.S3_ACCESS_KEY_ID),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY", env.S3_SECRET_ACCESS_KEY),
    ...(env.S3_SESSION_TOKEN ? { sessionToken: env.S3_SESSION_TOKEN } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
  };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
/** The largest expiry AWS accepts on a pre-signed URL: seven days. */
export const MAX_PRESIGN_TTL_SEC = 7 * 24 * 60 * 60;

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * RFC 3986 encoding, which is *not* what `encodeURIComponent` does.
 *
 * `encodeURIComponent` leaves `!`, `'`, `(`, `)` and `*` alone; SigV4 requires
 * them percent-encoded. Getting this wrong produces a signature mismatch only
 * for keys containing those characters, which is exactly the kind of bug that
 * passes every test written against `submissions/<uuid>/pages/000.jpg`.
 */
export function encodeRfc3986(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? encoded.replace(/%2F/g, "/") : encoded;
}

function amzDate(now: Date): { amz: string; date: string } {
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz, date: amz.slice(0, 8) };
}

function signingKey(config: S3Config, date: string): Buffer {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

/** `20260901/auto/s3/aws4_request` */
function credentialScope(config: S3Config, date: string): string {
  return `${date}/${config.region}/${SERVICE}/aws4_request`;
}

/**
 * Where an object lives, as a URL. The key is encoded segment-wise: the slashes
 * separating `submissions/<id>/pages/000.jpg` are path structure, everything
 * else is data.
 */
export function objectUrl(config: S3Config, key: string): URL {
  const base = new URL(config.endpoint);
  const encodedKey = encodeRfc3986(key, true);
  if (config.forcePathStyle) {
    base.pathname = `/${encodeRfc3986(config.bucket)}/${encodedKey}`;
  } else {
    base.host = `${config.bucket}.${base.host}`;
    base.pathname = `/${encodedKey}`;
  }
  return base;
}

function canonicalQuery(params: URLSearchParams): string {
  // Sorted by encoded key, then by encoded value — byte order, which is what
  // `Array.prototype.sort` on strings gives for ASCII.
  const pairs: string[] = [];
  for (const [k, v] of params) pairs.push(`${encodeRfc3986(k)}=${encodeRfc3986(v)}`);
  return pairs.sort().join("&");
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Sign a request with an `Authorization` header (SigV4 "header auth").
 *
 * Only the headers listed in `SignedHeaders` are covered. `content-length` is
 * deliberately not among them: `fetch` sets it itself and a value signed here
 * that differs by so much as a whitespace convention fails the whole request.
 * The payload digest already pins the body's length as surely as its content.
 */
export function signRequest(
  config: S3Config,
  opts: {
    method: string;
    key: string;
    payload?: Buffer;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    now?: Date;
  },
): SignedRequest {
  const now = opts.now ?? new Date();
  const { amz, date } = amzDate(now);
  const url = objectUrl(config, opts.key);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const payloadHash = sha256Hex(opts.payload ?? Buffer.alloc(0));

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
    ...(config.sessionToken ? { "x-amz-security-token": config.sessionToken } : {}),
    ...Object.fromEntries(
      Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()]),
    ),
  };

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].replace(/\s+/g, " ").trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    opts.method,
    // S3 is the one service that does *not* double-encode the canonical URI.
    url.pathname,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amz,
    credentialScope(config, date),
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hmac(signingKey(config, date), stringToSign).toString("hex");

  return {
    url: url.toString(),
    headers: {
      ...headers,
      authorization:
        `${ALGORITHM} Credential=${config.accessKeyId}/${credentialScope(config, date)}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/**
 * A URL a browser may GET for `ttlSec` seconds, with no credential of its own.
 *
 * `extraQuery` is signed along with everything else, which is what makes
 * `response-content-disposition=attachment` worth setting: the store echoes it
 * back as a response header, so an object that turns out to be HTML downloads
 * rather than rendering — the same protection `/api/dev/storage/` gives on the
 * local driver, kept when the bytes move to a different origin.
 */
export function presignGet(
  config: S3Config,
  key: string,
  ttlSec: number,
  extraQuery: Record<string, string> = {},
  now: Date = new Date(),
): string {
  const expires = Math.min(Math.max(Math.floor(ttlSec), 1), MAX_PRESIGN_TTL_SEC);
  const { amz, date } = amzDate(now);
  const url = objectUrl(config, key);

  for (const [k, v] of Object.entries(extraQuery)) url.searchParams.set(k, v);
  url.searchParams.set("X-Amz-Algorithm", ALGORITHM);
  url.searchParams.set("X-Amz-Credential", `${config.accessKeyId}/${credentialScope(config, date)}`);
  url.searchParams.set("X-Amz-Date", amz);
  url.searchParams.set("X-Amz-Expires", String(expires));
  if (config.sessionToken) url.searchParams.set("X-Amz-Security-Token", config.sessionToken);
  url.searchParams.set("X-Amz-SignedHeaders", "host");

  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    "host",
    // A pre-signed URL is handed to a browser, which will not send a body and
    // cannot compute a digest. UNSIGNED-PAYLOAD is the defined value for that.
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amz,
    credentialScope(config, date),
    sha256Hex(canonicalRequest),
  ].join("\n");

  url.searchParams.set(
    "X-Amz-Signature",
    hmac(signingKey(config, date), stringToSign).toString("hex"),
  );
  return url.toString();
}

// ---------------------------------------------------------------------------
// The four calls
// ---------------------------------------------------------------------------

export class S3RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "S3RequestError";
    this.status = status;
    this.code = code;
  }
}

/** S3 errors are XML. One regex is enough for `<Code>` and `<Message>`. */
function parseS3Error(status: number, body: string): S3RequestError {
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1] ?? `HTTP_${status}`;
  const message = /<Message>([^<]*)<\/Message>/.exec(body)?.[1] ?? body.slice(0, 200);
  return new S3RequestError(status, code, message || `S3 responded ${status}`);
}

async function send(signed: SignedRequest, method: string, body?: Buffer): Promise<Response> {
  const res = await fetch(signed.url, {
    method,
    headers: signed.headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
    // Node's fetch would otherwise reuse a cached response for a repeated GET.
    cache: "no-store",
  });
  return res;
}

export async function s3Put(
  config: S3Config,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const signed = signRequest(config, {
    method: "PUT",
    key,
    payload: body,
    headers: { "content-type": contentType },
  });
  const res = await send(signed, "PUT", body);
  if (!res.ok) throw parseS3Error(res.status, await res.text());
}

export async function s3Get(
  config: S3Config,
  key: string,
): Promise<{ body: Buffer; contentType: string; bytes: number }> {
  const signed = signRequest(config, { method: "GET", key });
  const res = await send(signed, "GET");
  if (!res.ok) throw parseS3Error(res.status, await res.text());
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    body: buf,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    bytes: buf.byteLength,
  };
}

export async function s3Head(config: S3Config, key: string): Promise<boolean> {
  const signed = signRequest(config, { method: "HEAD", key });
  const res = await send(signed, "HEAD");
  if (res.ok) return true;
  if (res.status === 404 || res.status === 403) return false;
  throw parseS3Error(res.status, await res.text());
}

export async function s3Delete(config: S3Config, key: string): Promise<void> {
  const signed = signRequest(config, { method: "DELETE", key });
  const res = await send(signed, "DELETE");
  // S3 deletes are idempotent: a missing key is a 204, not a 404.
  if (!res.ok && res.status !== 404) throw parseS3Error(res.status, await res.text());
}
