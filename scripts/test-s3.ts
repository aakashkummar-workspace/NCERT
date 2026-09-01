/**
 * Proves the hand-written SigV4 in src/lib/s3.ts against a real S3 server.
 *
 * A signing bug does not look like a bug. It looks like `SignatureDoesNotMatch`
 * on a good day and like an upload that appears to succeed on a bad one, so
 * this file exists to make "the S3 driver works" a claim somebody ran rather
 * than a claim somebody read. It round-trips actual bytes: put, fetch the
 * pre-signed URL with no credentials at all, compare the SHA-256, delete, and
 * confirm the object is gone.
 *
 * ## Running it
 *
 * Against a throwaway MinIO (nothing else on the machine is touched, and the
 * container is named so it is obvious what to remove):
 *
 * ```bash
 * docker run -d --name ncert-minio -p 9010:9000 \
 *   -e MINIO_ROOT_USER=ncertminio -e MINIO_ROOT_PASSWORD=ncertminio123 \
 *   minio/minio:latest server /data
 * docker exec ncert-minio mkdir -p /data/ncert-test
 *
 * S3_ENDPOINT=http://127.0.0.1:9010 S3_BUCKET=ncert-test S3_REGION=us-east-1 \
 * S3_ACCESS_KEY_ID=ncertminio S3_SECRET_ACCESS_KEY=ncertminio123 \
 *   npx tsx scripts/test-s3.ts
 *
 * docker rm -f ncert-minio
 * ```
 *
 * Against R2 or AWS, set the same four variables to the real ones and point
 * them at a scratch bucket. The script only ever writes under the
 * `submissions/00000000-…/` prefix and deletes what it wrote.
 *
 * With no `S3_ENDPOINT` set it skips, so it is safe to run anywhere.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  encodeRfc3986,
  presignGet,
  s3ConfigFromEnv,
  signRequest,
  type S3Config,
} from "@/lib/s3";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

// ---------------------------------------------------------------------------
// Offline checks — the parts of signing that have a right answer on paper
// ---------------------------------------------------------------------------

function offlineChecks(): void {
  console.log("\nsigning primitives");

  // encodeURIComponent leaves these five alone; SigV4 does not.
  eq("encodeRfc3986 escapes !'()*", encodeRfc3986("a!'()*b"), "a%21%27%28%29%2Ab");
  eq("encodeRfc3986 escapes / by default", encodeRfc3986("a/b"), "a%2Fb");
  eq("encodeRfc3986 keeps / when asked", encodeRfc3986("a/b", true), "a/b");
  eq("encodeRfc3986 leaves unreserved alone", encodeRfc3986("A-Z_a.z~0"), "A-Z_a.z~0");

  const config: S3Config = {
    endpoint: "https://example.invalid",
    region: "us-east-1",
    bucket: "b",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    forcePathStyle: true,
  };
  const now = new Date("2026-09-01T12:00:00Z");

  // Determinism: the same inputs must produce the same signature, or nothing
  // below this line means anything.
  const a = signRequest(config, { method: "GET", key: "k/1.jpg", now });
  const b = signRequest(config, { method: "GET", key: "k/1.jpg", now });
  eq("signature is deterministic", a.headers.authorization, b.headers.authorization);

  // ...and sensitive to every input that is supposed to be covered.
  const differs = (label: string, other: string) =>
    check(`signature covers ${label}`, other !== a.headers.authorization);
  differs("the method", signRequest(config, { method: "DELETE", key: "k/1.jpg", now }).headers.authorization);
  differs("the key", signRequest(config, { method: "GET", key: "k/2.jpg", now }).headers.authorization);
  differs("the body", signRequest(config, { method: "GET", key: "k/1.jpg", payload: Buffer.from("x"), now }).headers.authorization);
  differs(
    "extra headers",
    signRequest(config, { method: "GET", key: "k/1.jpg", headers: { "content-type": "image/jpeg" }, now })
      .headers.authorization,
  );
  differs(
    "the query string",
    signRequest(config, { method: "GET", key: "k/1.jpg", query: { versionId: "7" }, now }).headers.authorization,
  );

  check(
    "credential scope is date/region/s3/aws4_request",
    a.headers.authorization.includes("Credential=AKIAIOSFODNN7EXAMPLE/20260901/us-east-1/s3/aws4_request"),
    a.headers.authorization,
  );
  eq("x-amz-date is basic ISO8601", a.headers["x-amz-date"], "20260901T120000Z");
  eq(
    "empty body hashes to the well-known SHA-256",
    a.headers["x-amz-content-sha256"],
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );

  // Path style vs virtual-hosted addressing.
  eq("path style puts the bucket in the path", new URL(a.url).pathname, "/b/k/1.jpg");
  const vhost = signRequest({ ...config, forcePathStyle: false }, { method: "GET", key: "k/1.jpg", now });
  eq("virtual host puts the bucket in the host", new URL(vhost.url).host, "b.example.invalid");
  eq("virtual host leaves the path as the key", new URL(vhost.url).pathname, "/k/1.jpg");

  // Pre-signed URL shape.
  const url = new URL(presignGet(config, "k/1.jpg", 900, { "response-content-disposition": "attachment" }, now));
  eq("presign algorithm", url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  eq("presign expires", url.searchParams.get("X-Amz-Expires"), "900");
  eq("presign signs only host", url.searchParams.get("X-Amz-SignedHeaders"), "host");
  eq(
    "presign carries the disposition it signed",
    url.searchParams.get("response-content-disposition"),
    "attachment",
  );
  check("presign carries a signature", (url.searchParams.get("X-Amz-Signature") ?? "").length === 64);
  check(
    "presign is clamped to seven days",
    new URL(presignGet(config, "k/1.jpg", 999_999_999, {}, now)).searchParams.get("X-Amz-Expires") === "604800",
  );
  check(
    "a different disposition is a different signature",
    new URL(presignGet(config, "k/1.jpg", 900, { "response-content-disposition": "inline" }, now)).searchParams.get(
      "X-Amz-Signature",
    ) !== url.searchParams.get("X-Amz-Signature"),
  );
}

// ---------------------------------------------------------------------------
// Live round trip
// ---------------------------------------------------------------------------

async function liveChecks(): Promise<void> {
  const config = s3ConfigFromEnv();
  console.log(`\nlive round trip against ${config.endpoint}/${config.bucket}`);

  process.env.STORAGE_DRIVER = "s3";
  // Imported after the environment is set: the module picks its driver once.
  const { default: storage, storageKeys } = await import("@/lib/storage");
  eq("driver selected", storage.name, "s3");

  const submissionId = randomUUID();
  const key = storageKeys.submissionPage(submissionId, 0, "jpg");

  // A real JPEG header followed by noise, so the bytes are not all the same and
  // a truncated or re-encoded body would show up in the digest.
  const body = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251)),
  ]);
  const expectedSha = createHash("sha256").update(body).digest("hex");

  const stored = await storage.put({ key, body, contentType: "image/jpeg", storageClass: "image" });
  eq("put returns the key", stored.key, key);
  eq("put measures the bytes", stored.bytes, body.byteLength);
  eq("put computes the digest", stored.sha256, expectedSha);

  eq("exists after put", await storage.exists(key), true);

  const readBack = await storage.read(key);
  eq("server-side read returns the bytes", readBack.bytes, body.byteLength);
  eq("server-side read round-trips exactly", createHash("sha256").update(readBack.body).digest("hex"), expectedSha);
  eq("content type survived", readBack.contentType, "image/jpeg");

  // The point of the whole exercise: a URL with no credential attached, fetched
  // by something that knows nothing about this process.
  const signed = await storage.getSignedUrl(key, 300);
  check("signed URL is absolute and points at the store", signed.startsWith(config.endpoint), signed);
  const res = await fetch(signed);
  eq("signed GET status", res.status, 200);
  const fetched = Buffer.from(await res.arrayBuffer());
  eq("signed GET round-trips exactly", createHash("sha256").update(fetched).digest("hex"), expectedSha);
  eq("signed GET length", fetched.byteLength, body.byteLength);
  check(
    "signed GET forces a download",
    (res.headers.get("content-disposition") ?? "").includes("attachment"),
    res.headers.get("content-disposition") ?? "(none)",
  );

  // A signature that has been fiddled with must not open the door.
  const tampered = new URL(signed);
  const sig = tampered.searchParams.get("X-Amz-Signature")!;
  tampered.searchParams.set("X-Amz-Signature", sig.replace(/.$/, sig.endsWith("a") ? "b" : "a"));
  eq("a tampered signature is refused", (await fetch(tampered)).status, 403);

  // So must one that has run out.
  const stale = presignGet(config, key, 1, {}, new Date(Date.now() - 60_000));
  eq("an expired URL is refused", (await fetch(stale)).status, 403);

  // Policy is enforced before anything reaches the network, on this driver too.
  let rejectedType = false;
  try {
    await storage.put({ key, body, contentType: "text/html", storageClass: "image" });
  } catch {
    rejectedType = true;
  }
  check("an unlisted content type is still refused", rejectedType);

  let rejectedSize = false;
  try {
    await storage.put({
      key,
      body: Buffer.alloc(13 * 1024 * 1024, 1),
      contentType: "image/jpeg",
      storageClass: "image",
    });
  } catch {
    rejectedSize = true;
  }
  check("an oversized body is still refused", rejectedSize);

  await storage.delete(key);
  eq("gone after delete", await storage.exists(key), false);
  eq("the signed URL dies with the object", (await fetch(signed)).status, 404);

  let notFound = "";
  try {
    await storage.read(key);
  } catch (err) {
    notFound = (err as { code?: string }).code ?? String(err);
  }
  eq("read of a deleted object is NOT_FOUND", notFound, "NOT_FOUND");

  // Deleting twice is not an error; S3 deletes are idempotent and a retry after
  // a dropped connection must not fail.
  await storage.delete(key);
  check("delete is idempotent", true);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  offlineChecks();

  if (process.env.S3_ENDPOINT) {
    await liveChecks();
  } else {
    console.log("\nlive round trip SKIPPED — set S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY.");
    console.log("Signing was checked on paper only. That is not the same thing; see the header of this file.");
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
