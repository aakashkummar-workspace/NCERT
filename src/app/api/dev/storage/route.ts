/**
 * GET /api/dev/storage/?key=&expires=&signature=  — serve an object from the
 * local storage driver.
 *
 * This is the counterpart to `storage.getSignedUrl()` on the `local` driver.
 * The `s3` driver has no equivalent — S3 signs and serves its own URLs — which
 * is why this lives under `/api/dev/` rather than pretending to be a permanent
 * part of the API surface. Delete it with the local driver.
 *
 * ## It checks the signature *and* the session, and the second is the real one
 *
 * A valid signature proves only that we minted the link and that it has not
 * expired yet. Links get forwarded, screenshotted, and pasted into class group
 * chats. If the signature were the whole check, one shared link would be one
 * student's handwriting readable by anyone it reached, for as long as it lived.
 *
 * So the signature is a cheap first gate, and then `authorise()` below asks the
 * question that actually matters: does the person holding this cookie have any
 * business seeing this object? A student may read their own; an evaluator may
 * read a submission they have claimed or reviewed; an admin may read anything
 * inside their own scope.
 */
import { NextResponse } from "next/server";
import type { User } from "@prisma/client";
import { ApiError, route } from "@/lib/api";
import { isProduction } from "@/lib/auth";
import prisma from "@/lib/db";
import storage, { verifySignedUrl } from "@/lib/storage";

/**
 * The submission an object belongs to, from its key prefix. The key grammar in
 * src/lib/storage.ts is what makes this parseable rather than guessy.
 */
async function ownerOf(key: string): Promise<{ studentId: string; submissionId: string } | null> {
  const page = key.match(/^submissions\/([0-9a-f-]{36})\//i);
  if (page) {
    const submission = await prisma.submission.findUnique({
      where: { id: page[1] },
      select: { id: true, studentId: true },
    });
    return submission ? { studentId: submission.studentId, submissionId: submission.id } : null;
  }

  const note = key.match(/^voice-notes\/([0-9a-f-]{36})\//i);
  if (note) {
    const answer = await prisma.answer.findUnique({
      where: { id: note[1] },
      select: { submission: { select: { id: true, studentId: true } } },
    });
    return answer
      ? { studentId: answer.submission.studentId, submissionId: answer.submission.id }
      : null;
  }

  return null;
}

async function authorise(user: User, key: string): Promise<void> {
  const owner = await ownerOf(key);
  if (!owner) {
    // An object whose owner cannot be established is not served to anybody.
    // Failing closed is the only safe default here: the alternative is that an
    // unrecognised key prefix is world-readable to every signed-in user.
    throw ApiError.notFound("Object");
  }

  if (owner.studentId === user.id) return;

  if (user.role === "ADMIN") {
    const student = await prisma.user.findUnique({
      where: { id: owner.studentId },
      select: { scopeId: true },
    });
    // An admin is an admin *of a scope*, not of the platform. A school
    // administrator reading another school's answer sheets is the thing
    // tenancy exists to prevent, and it costs one comparison to prevent it now
    // rather than after the first B2B customer.
    if (student?.scopeId === user.scopeId) return;
    throw ApiError.notFound("Object");
  }

  if (user.role === "EVALUATOR") {
    const ticket = await prisma.evaluationTicket.findUnique({
      where: { submissionId: owner.submissionId },
      select: {
        claimedById: true,
        assignedEvaluatorId: true,
        reviews: { where: { evaluatorId: user.id }, select: { id: true }, take: 1 },
      },
    });
    // Claimed by them, assigned to them, or already reviewed by them. Not "any
    // evaluator": the queue decides who sees what, and an evaluator who can
    // read every submission by URL has no queue.
    if (
      ticket &&
      (ticket.claimedById === user.id ||
        ticket.assignedEvaluatorId === user.id ||
        ticket.reviews.length > 0)
    ) {
      return;
    }
  }

  throw ApiError.notFound("Object");
}

export const GET = route({ auth: "any" }, async ({ req, user }) => {
  if (isProduction()) throw ApiError.notFound("Route");

  const params = req.nextUrl.searchParams;
  const key = verifySignedUrl(
    params.get("key") ?? "",
    params.get("expires") ?? "",
    params.get("signature") ?? "",
  );

  await authorise(user, key);

  const object = await storage.read(key);
  return new NextResponse(new Uint8Array(object.body), {
    headers: {
      "content-type": object.contentType,
      "content-length": String(object.bytes),
      // The content type came from an allowlist, but nosniff and an attachment
      // disposition mean that even a mislabelled object cannot be rendered as
      // markup in our own origin.
      "x-content-type-options": "nosniff",
      "content-disposition": "attachment",
      "cache-control": "private, max-age=300",
    },
  });
});
