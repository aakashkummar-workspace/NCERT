/**
 * POST /api/submissions/   create a submission     (STUDENT, idempotent)
 * GET  /api/submissions/   the caller's own, newest first
 *
 * Note the trailing slash. `next.config.ts` sets `trailingSlash: true` and it
 * must stay true, so `POST /api/submissions` 308-redirects and a client that
 * does not re-send the body on the redirect looks like a mysteriously empty
 * request.
 *
 * The student is `ctx.user`, from the session cookie. There is no `studentId`
 * in this body and there is no route in this codebase where there is one.
 */
import { NextResponse } from "next/server";
import { createOnceStrict, route, v } from "@/lib/api";
import prisma from "@/lib/db";

export const POST = route(
  {
    auth: "STUDENT",
    idempotent: true,
    body: v.object({
      paperSlug: v.optional(v.string({ max: 120 })),
      attemptId: v.optional(v.uuid()),
      subject: v.string({ max: 60 }),
      classNum: v.int({ min: 9, max: 10 }),
      /** How many photographs the phone is about to upload. */
      pageCount: v.int({ min: 1, max: 40 }),
      /** The phone's clock. May precede `createdAt` by hours if the upload waited. */
      capturedAt: v.optional(v.date()),
    }),
  },
  async ({ user, body, idempotencyKey }) => {
    // An attempt named in the body is only accepted if it is the caller's own.
    // Otherwise a student could hang their answer sheet off someone else's run.
    let attemptId: string | null = null;
    if (body.attemptId) {
      const attempt = await prisma.attempt.findFirst({
        where: { id: body.attemptId, studentId: user.id },
        select: { id: true },
      });
      attemptId = attempt?.id ?? null;
    }

    // Strict, because the body carries something the row records. Answering
    // "yes, done" to a *different* page count would silently discard a real
    // request — a second, longer answer sheet uploaded under a reused key.
    const { row, created } = await createOnceStrict({
      constraint: "idempotencyKey",
      matches: (existing) => existing.pageCount === body.pageCount,
      create: () =>
        prisma.submission.create({
          data: {
            studentId: user.id,
            idempotencyKey,
            attemptId,
            paperSlug: body.paperSlug ?? null,
            subject: body.subject,
            classNum: body.classNum,
            pageCount: body.pageCount,
            capturedAt: body.capturedAt ?? null,
            status: "UPLOADING",
          },
        }),
      find: () =>
        // Scoped to the acting user, the way the unique itself is. A global
        // lookup would hand one student another's row the first time two
        // clients generated the same key.
        prisma.submission.findUnique({
          where: { studentId_idempotencyKey: { studentId: user.id, idempotencyKey } },
        }),
    });

    return NextResponse.json(
      {
        submissionId: row.id,
        status: row.status,
        pageCount: row.pageCount,
        created,
      },
      { status: created ? 201 : 200 },
    );
  },
);

export const GET = route({ auth: "STUDENT" }, async ({ user }) => {
  const submissions = await prisma.submission.findMany({
    where: { studentId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      paperSlug: true,
      subject: true,
      classNum: true,
      status: true,
      pageCount: true,
      failureReason: true,
      capturedAt: true,
      gradedAt: true,
      createdAt: true,
      _count: { select: { pages: true, answers: true } },
    },
  });
  return { submissions };
});
