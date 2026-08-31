/**
 * POST /api/submissions/{id}/pages/   attach one photograph   (STUDENT, owner)
 * GET  /api/submissions/{id}/pages/   the pages, with short-lived signed URLs
 *
 * ## Why this takes the bytes rather than handing out a pre-signed PUT
 *
 * `src/lib/storage.ts` signs GETs only; there is no upload-signing primitive on
 * either driver, and the `s3` driver throws on every method. Inventing one here
 * would mean the browser writing straight to a bucket, and the three things the
 * schema insists are measured — content type, size and `sha256` — would then be
 * whatever the client claimed. §4 of docs/PLATFORM.md is explicit that they are
 * pinned server-side and that there is no parameter to pass them in. So the
 * bytes come through this route, `storage.put()` measures them, and the row
 * records what was stored rather than what we were told.
 *
 * A pre-signed PUT is still the right shape for S3, and the seam is ready for
 * it: everything downstream reads `storageKey` and nothing reads a URL.
 *
 * `multipart/form-data`, not JSON — a 12 MB photograph base64-encoded into a
 * JSON body is 16 MB of string on a phone that is paying by the megabyte.
 */
import { NextResponse } from "next/server";
import { ApiError, createOnce, route } from "@/lib/api";
import prisma from "@/lib/db";
import storage, { extensionFor, storageKeys } from "@/lib/storage";
import { param, requireOwnSubmission, requireVisibleSubmission } from "../../access";

/**
 * Width and height, read out of the file header.
 *
 * Read rather than accepted: the columns exist so a highlight box in normalised
 * coordinates can be turned back into pixels, and a client-declared size would
 * put every box in the wrong place on the one phone that got it wrong. Ported
 * from `scripts/spike-grade.mjs`, which needs the same numbers to price a run.
 */
function imageDimensions(buf: Buffer, contentType: string): { width: number; height: number } | null {
  if (contentType === "image/png" && buf.length > 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (contentType === "image/jpeg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc), carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

export const POST = route({ auth: "STUDENT" }, async ({ req, user, params }) => {
  const submissionId = param(params, "id");
  await requireOwnSubmission(user, submissionId);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Send this as multipart/form-data.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw ApiError.validation([{ path: "file", message: "is required" }]);
  }
  const rawIndex = String(form.get("pageIndex") ?? "");
  const pageIndex = Number(rawIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 39) {
    throw ApiError.validation([{ path: "pageIndex", message: "must be an integer from 0 to 39" }]);
  }
  const replace = String(form.get("replace") ?? "") === "true";

  // The type comes off the upload, but `storage.put()` checks it against an
  // allowlist it owns and refuses anything else. A client-declared image/jpeg
  // on a file that is actually HTML is a stored-XSS delivery mechanism the
  // moment something serves it back with that type.
  const contentType = file.type || "application/octet-stream";
  const bytes = Buffer.from(await file.arrayBuffer());

  if (replace) {
    const existing = await prisma.submissionPage.findUnique({
      where: { submissionId_pageIndex: { submissionId, pageIndex } },
      select: { id: true, storageKey: true },
    });
    if (existing) {
      await storage.delete(existing.storageKey);
      await prisma.submissionPage.delete({ where: { id: existing.id } });
    }
  }

  const object = await storage.put({
    key: storageKeys.submissionPage(submissionId, pageIndex, extensionFor(contentType)),
    body: bytes,
    contentType,
    storageClass: "image",
  });
  const dimensions = imageDimensions(bytes, object.contentType);

  // The unique on (submissionId, pageIndex) is the idempotency guard: a phone
  // that retried an upload it never saw the answer to gets the same row back
  // rather than a second copy of page 3.
  const { row, created } = await createOnce({
    constraint: "pageIndex",
    create: () =>
      prisma.submissionPage.create({
        data: {
          submissionId,
          pageIndex,
          // The key, on the row. Never a URL — a pre-signed one is a dead link
          // by the next day.
          storageKey: object.key,
          contentType: object.contentType,
          bytes: object.bytes,
          sha256: object.sha256,
          widthPx: dimensions?.width ?? null,
          heightPx: dimensions?.height ?? null,
        },
      }),
    find: () =>
      prisma.submissionPage.findUnique({
        where: { submissionId_pageIndex: { submissionId, pageIndex } },
      }),
  });

  return NextResponse.json(
    {
      pageId: row.id,
      pageIndex: row.pageIndex,
      bytes: row.bytes,
      sha256: row.sha256,
      widthPx: row.widthPx,
      heightPx: row.heightPx,
      created,
    },
    { status: created ? 201 : 200 },
  );
});

export const GET = route({ auth: "any" }, async ({ user, params }) => {
  const submissionId = param(params, "id");
  await requireVisibleSubmission(user, submissionId);

  const pages = await prisma.submissionPage.findMany({
    where: { submissionId },
    orderBy: { pageIndex: "asc" },
    select: {
      id: true,
      pageIndex: true,
      contentType: true,
      bytes: true,
      widthPx: true,
      heightPx: true,
      ocrStatus: true,
      storageKey: true,
    },
  });

  return {
    pages: await Promise.all(
      pages.map(async ({ storageKey, ...page }) => ({
        ...page,
        // Signed at read time, every time. Fifteen minutes, and never stored.
        url: await storage.getSignedUrl(storageKey),
      })),
    ),
  };
});
