/**
 * Who may see one submission.
 *
 * Not a route. The rule is the same one `/api/dev/storage/` applies to an
 * object, and it is written once here so the two cannot drift: a student may
 * read their own; an evaluator may read a submission they have claimed, been
 * assigned, or already reviewed — not any submission, because an evaluator who
 * can read everything has no queue; an admin may read anything **inside their
 * own scope**, because an admin is an admin of a scope and not of the platform.
 *
 * Every refusal is a 404, never a 403. A 403 that distinguishes "not yours"
 * from "does not exist" is a membership oracle: it tells a stranger which
 * submission ids are real.
 *
 * The acting user is always the argument, and it always came from the session.
 * Nothing here takes a student id from anywhere else.
 */
import type { User } from "@prisma/client";
import { ApiError } from "@/lib/api";
import prisma from "@/lib/db";

export interface SubmissionOwner {
  id: string;
  studentId: string;
}

export async function requireVisibleSubmission(
  user: User,
  submissionId: string,
): Promise<SubmissionOwner> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { id: true, studentId: true },
  });
  if (!submission) throw ApiError.notFound("Submission");
  if (submission.studentId === user.id) return submission;

  if (user.role === "ADMIN") {
    const student = await prisma.user.findUnique({
      where: { id: submission.studentId },
      select: { scopeId: true },
    });
    if (student?.scopeId === user.scopeId) return submission;
    throw ApiError.notFound("Submission");
  }

  if (user.role === "EVALUATOR") {
    const ticket = await prisma.evaluationTicket.findUnique({
      where: { submissionId },
      select: {
        claimedById: true,
        assignedEvaluatorId: true,
        reviews: { where: { evaluatorId: user.id }, select: { id: true }, take: 1 },
      },
    });
    if (
      ticket &&
      (ticket.claimedById === user.id ||
        ticket.assignedEvaluatorId === user.id ||
        ticket.reviews.length > 0)
    ) {
      return submission;
    }
  }

  throw ApiError.notFound("Submission");
}

/**
 * Only the student who owns a submission may add to it. An evaluator reading a
 * script is not a reason to let them upload a page into it.
 */
export async function requireOwnSubmission(
  user: User,
  submissionId: string,
): Promise<SubmissionOwner> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { id: true, studentId: true },
  });
  if (!submission || submission.studentId !== user.id) throw ApiError.notFound("Submission");
  return submission;
}

/** A dynamic segment as a string. `params` is already awaited by `route()`. */
export function param(params: Record<string, string | string[]>, name: string): string {
  const value = params[name];
  const one = Array.isArray(value) ? value[0] : value;
  if (!one) throw ApiError.notFound("Submission");
  return one;
}
