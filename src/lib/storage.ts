/**
 * Where a photographed answer sheet and a 90-second voice note actually live.
 *
 * The schema is emphatic that `SubmissionPage.storageKey` and
 * `VoiceNote.storageKey` are **object keys, never URLs**: a pre-signed URL
 * expires, so a stored one is a dead link by the next day. This module is the
 * only thing that turns a key into something a browser can fetch, and it does
 * it at read time, every time.
 *
 * ## Two drivers, one interface
 *
 * `local` writes under a gitignored directory and hands out short-lived signed
 * URLs pointing at `/api/dev/storage/…`, which checks the signature and then
 * checks that the signed-in user is allowed the object. `s3` talks to any
 * S3-compatible store — R2, AWS S3, MinIO — and lets the store sign and serve
 * its own URLs. Signing lives in `src/lib/s3.ts`; no provider is named in
 * either file, only an endpoint read from the environment.
 *
 * ## What is pinned server-side, and why all of it is
 *
 * `put()` takes bytes, not a promise about bytes:
 *
 * - **Content type** comes from an allowlist this module owns. A client-declared
 *   `image/jpeg` on a file that is actually HTML is a stored-XSS delivery
 *   mechanism the moment anything serves it back with that type. The route that
 *   serves objects also sends `X-Content-Type-Options: nosniff` and
 *   `Content-Disposition: attachment`, so even a mislabelled object cannot be
 *   rendered in our origin.
 * - **Size** is measured from the buffer, not read from `Content-Length`. A
 *   client that lies about its length lies for a reason.
 * - **`sha256`** is computed here, so the column of that name on
 *   `SubmissionPage` records what we stored rather than what we were told.
 *
 * All three end up on the row. The caller cannot pass them in — there is no
 * parameter for it.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api";
import {
  S3RequestError,
  presignGet,
  s3ConfigFromEnv,
  s3Delete,
  s3Get,
  s3Head,
  s3Put,
} from "@/lib/s3";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Everything this platform will ever store, and the ceiling for each.
 *
 * A page limit of 12 MB is a phone camera photo at full resolution with room to
 * spare; a voice note at 90 seconds of Opus is under 1 MB and the 8 MB here is
 * slack for a phone that records WAV.
 */
export const STORAGE_POLICY = {
  image: {
    contentTypes: ["image/jpeg", "image/png", "image/webp", "image/heic"] as const,
    maxBytes: 12 * 1024 * 1024,
  },
  audio: {
    contentTypes: ["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac"] as const,
    maxBytes: 8 * 1024 * 1024,
  },
  document: {
    contentTypes: ["application/pdf"] as const,
    maxBytes: 25 * 1024 * 1024,
  },
} as const;

export type StorageClass = keyof typeof STORAGE_POLICY;

/**
 * The key grammar. Enforced on the way in and again on the way out, because the
 * read path takes a key from a URL and the difference between a key and a path
 * is one `..` segment.
 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,500}$/i;

function assertSafeKey(key: string): string {
  if (!KEY_PATTERN.test(key) || key.includes("..") || key.includes("//")) {
    throw ApiError.validation([{ path: "storageKey", message: "is not a valid object key" }]);
  }
  return key;
}

/**
 * Key builders. Centralised so that the prefix is a fact rather than a
 * convention — a lifecycle rule, a bulk delete, or an access policy is written
 * against a prefix, and a prefix invented at three call sites is three prefixes.
 */
export const storageKeys = {
  submissionPage(submissionId: string, pageIndex: number, ext: string): string {
    return assertSafeKey(`submissions/${submissionId}/pages/${String(pageIndex).padStart(3, "0")}.${ext}`);
  },
  voiceNote(answerId: string, voiceNoteId: string, ext: string): string {
    return assertSafeKey(`voice-notes/${answerId}/${voiceNoteId}.${ext}`);
  },
};

export function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "application/pdf": "pdf",
  };
  return map[contentType] ?? "bin";
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface PutOptions {
  key: string;
  body: Buffer | Uint8Array | ArrayBuffer;
  /** Checked against `STORAGE_POLICY[storageClass].contentTypes`. */
  contentType: string;
  storageClass: StorageClass;
}

/** What the caller writes onto the row. Every field is measured, not claimed. */
export interface StoredObject {
  key: string;
  contentType: string;
  bytes: number;
  sha256: string;
}

export interface ObjectBody {
  body: Buffer;
  contentType: string;
  bytes: number;
}

export interface StorageDriver {
  readonly name: "local" | "s3";
  put(opts: PutOptions): Promise<StoredObject>;
  /** A URL a browser may GET for `ttlSec`. Never store the result. */
  getSignedUrl(key: string, ttlSec?: number): Promise<string>;
  delete(key: string): Promise<void>;
  /** Server-side read. Used by the serving route; not part of the client story. */
  read(key: string): Promise<ObjectBody>;
  exists(key: string): Promise<boolean>;
}

export const DEFAULT_URL_TTL_SEC = 15 * 60;

function toBuffer(body: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

function checkPolicy(opts: PutOptions, bytes: number): void {
  const policy = STORAGE_POLICY[opts.storageClass];
  const allowed = policy.contentTypes as readonly string[];
  if (!allowed.includes(opts.contentType)) {
    throw new ApiError(
      "UNSUPPORTED_MEDIA_TYPE",
      `${opts.contentType} is not accepted here. Allowed: ${allowed.join(", ")}.`,
    );
  }
  if (bytes === 0) {
    throw ApiError.validation([{ path: "body", message: "is empty" }]);
  }
  if (bytes > policy.maxBytes) {
    throw new ApiError(
      "PAYLOAD_TOO_LARGE",
      `That file is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${policy.maxBytes / 1024 / 1024} MB.`,
    );
  }
}

// ---------------------------------------------------------------------------
// URL signing (shared by the local driver and its serving route)
// ---------------------------------------------------------------------------

function urlSecret(): Buffer {
  const configured = process.env.STORAGE_URL_SECRET ?? process.env.SESSION_SECRET;
  if (configured && configured.length >= 16) return Buffer.from(configured, "utf8");
  if (process.env.NODE_ENV === "production") {
    throw new Error("STORAGE_URL_SECRET (or SESSION_SECRET) is unset.");
  }
  return Buffer.from("dev-only-insecure-storage-secret", "utf8");
}

function signUrl(key: string, expires: number): string {
  return createHmac("sha256", urlSecret()).update(`${key}:${expires}`).digest("base64url");
}

/**
 * Verify a signed object URL. Returns the key, or throws.
 *
 * A valid signature proves the URL was minted by us and has not expired. It
 * does **not** prove the person holding it is allowed the object — a URL gets
 * forwarded, screenshotted and pasted into a group chat. The serving route
 * checks ownership separately, against the session. Treating the signature as
 * authorisation is the mistake this comment exists to prevent.
 */
export function verifySignedUrl(key: string, expires: string, signature: string): string {
  const safe = assertSafeKey(key);
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) {
    throw new ApiError("FORBIDDEN", "That link has expired.");
  }
  const expected = signUrl(safe, exp);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApiError("FORBIDDEN", "That link is not valid.");
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Local driver
// ---------------------------------------------------------------------------

/**
 * Gitignored. `.storage/` rather than `public/` on purpose: anything under
 * `public/` is served by Next.js with no check at all, which would make every
 * student's answer sheet world-readable to anyone who can guess a UUID.
 */
export const LOCAL_STORAGE_ROOT = process.env.STORAGE_LOCAL_ROOT
  ? path.resolve(process.env.STORAGE_LOCAL_ROOT)
  : path.resolve(process.cwd(), ".storage");

function localPath(key: string): string {
  const resolved = path.resolve(LOCAL_STORAGE_ROOT, assertSafeKey(key));
  // Belt and braces over the key pattern: whatever the grammar allowed, the
  // resolved path must still sit inside the root.
  if (resolved !== LOCAL_STORAGE_ROOT && !resolved.startsWith(LOCAL_STORAGE_ROOT + path.sep)) {
    throw ApiError.validation([{ path: "storageKey", message: "escapes the storage root" }]);
  }
  return resolved;
}

const localDriver: StorageDriver = {
  name: "local",

  async put(opts) {
    const key = assertSafeKey(opts.key);
    const buf = toBuffer(opts.body);
    checkPolicy(opts, buf.byteLength);

    const target = localPath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, buf);
    // The content type is not a filesystem property, so it is written beside
    // the object. S3 keeps it as object metadata; the row keeps it too, and the
    // row is the authority — this sidecar only exists so the dev serving route
    // can answer without a database lookup.
    await writeFile(`${target}.meta`, JSON.stringify({ contentType: opts.contentType }), "utf8");

    return {
      key,
      contentType: opts.contentType,
      bytes: buf.byteLength,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  },

  async getSignedUrl(key, ttlSec = DEFAULT_URL_TTL_SEC) {
    const safe = assertSafeKey(key);
    const expires = Math.floor(Date.now() / 1000) + ttlSec;
    const qs = new URLSearchParams({
      key: safe,
      expires: String(expires),
      signature: signUrl(safe, expires),
    });
    // Relative on purpose: the caller's origin is the right origin, and a
    // hardcoded one is wrong on every deploy preview.
    return `/api/dev/storage/?${qs.toString()}`;
  },

  async delete(key) {
    const target = localPath(key);
    await rm(target, { force: true });
    await rm(`${target}.meta`, { force: true });
  },

  async read(key) {
    const target = localPath(key);
    let body: Buffer;
    try {
      body = await readFile(target);
    } catch {
      throw ApiError.notFound("Object");
    }
    let contentType = "application/octet-stream";
    try {
      const meta = JSON.parse(await readFile(`${target}.meta`, "utf8")) as { contentType?: string };
      if (meta.contentType) contentType = meta.contentType;
    } catch {
      // No sidecar. Falling back to octet-stream is the safe direction.
    }
    return { body, contentType, bytes: body.byteLength };
  },

  async exists(key) {
    try {
      await stat(localPath(key));
      return true;
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// S3 driver
// ---------------------------------------------------------------------------

/**
 * The production driver: any S3-compatible object store, addressed by endpoint,
 * bucket, region and credentials. No provider is named anywhere in it, because
 * naming one is how a codebase ends up unable to move off it — R2, AWS S3,
 * Backblaze B2 and MinIO differ here only in the value of `S3_ENDPOINT`.
 *
 * Signing is `src/lib/s3.ts`, hand-written over `node:crypto` rather than the
 * AWS SDK; that file's header argues the case and `scripts/test-s3.mjs` is what
 * makes it defensible.
 *
 * Everything this module pins server-side stays pinned. The content type sent
 * to S3 is the allowlisted one, not a client's claim; the length is the
 * buffer's; the SHA-256 that goes on the row is also sent as
 * `x-amz-content-sha256` and covered by the signature, so the store rejects the
 * request outright if the bytes on the wire are not the bytes we hashed.
 *
 * Note what does **not** change: callers still store `object.key`. A pre-signed
 * URL is minted at read time, expires, and is never written to a row.
 */
const s3Driver: StorageDriver = {
  name: "s3",

  async put(opts) {
    const key = assertSafeKey(opts.key);
    const buf = toBuffer(opts.body);
    checkPolicy(opts, buf.byteLength);

    await s3Put(s3ConfigFromEnv(), key, buf, opts.contentType);

    return {
      key,
      contentType: opts.contentType,
      bytes: buf.byteLength,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  },

  async getSignedUrl(key, ttlSec = DEFAULT_URL_TTL_SEC) {
    const safe = assertSafeKey(key);
    // Signed into the URL, so the store echoes them back as response headers.
    // An object that is not what its content type claims then downloads instead
    // of executing — the same guarantee /api/dev/storage/ gives on the local
    // driver, kept now that the bytes are served from a different origin.
    return presignGet(s3ConfigFromEnv(), safe, ttlSec, {
      "response-content-disposition": "attachment",
    });
  },

  async delete(key) {
    await s3Delete(s3ConfigFromEnv(), assertSafeKey(key));
  },

  async read(key) {
    try {
      return await s3Get(s3ConfigFromEnv(), assertSafeKey(key));
    } catch (err) {
      if (err instanceof S3RequestError && err.status === 404) throw ApiError.notFound("Object");
      throw err;
    }
  },

  async exists(key) {
    return s3Head(s3ConfigFromEnv(), assertSafeKey(key));
  },
};

/**
 * The driver every caller uses. Import `storage`, not a driver.
 *
 * `STORAGE_DRIVER=s3` selects S3; anything else, including unset, is local.
 * Defaulting to local rather than to S3 means a missing environment variable
 * fails in development, where it is noticed, rather than in production, where
 * it is not.
 */
export const storage: StorageDriver =
  process.env.STORAGE_DRIVER === "s3" ? s3Driver : localDriver;

export default storage;
