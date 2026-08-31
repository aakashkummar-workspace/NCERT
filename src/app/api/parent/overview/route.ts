/**
 * GET /api/parent/overview/?studentId=…  — the dashboard payload. PARENT only.
 *
 * `studentId` is a **selector, not an identity**. The acting user is the
 * session's, and `requireConsentedLink()` refuses unless that parent holds a
 * live, student-granted consent for that student. A parent who edits the query
 * string gets the same 403 as a stranger, and the 403 does not distinguish
 * "not linked" from "no such student" — a 403 that does is a membership oracle.
 * Omit it and you get your only child; a parent of two must name one.
 *
 * ## What this route deliberately does not carry
 *
 * The chapter list ships a **band**, not a figure. Chapter-level difficulty is
 * the interrogation-shaped surface on this whole screen: "why did you get 40%
 * in chapter 6" is a conversation that helps nobody, and it is one number away
 * at all times. A subject *trend* is direction-shaped rather than verdict-
 * shaped, so it keeps its fractions — you cannot draw a line without them.
 *
 * Everything here comes from `householdSnapshot()`, which is built only from
 * the guarded selects in src/lib/parent.ts, so no answer text, no scan, no
 * teacher's comment and no voice note is ever fetched, let alone serialised.
 */
import { ApiError, route } from "@/lib/api";
import { recommend } from "@/lib/insights";
import { householdSnapshot, linksForParent, requireConsentedLink } from "@/lib/parent";

/** Three bands, worded as states rather than as marks. */
function band(fraction: number | null): "not-marked" | "landing" | "coming-along" | "not-yet" {
  if (fraction === null) return "not-marked";
  if (fraction >= 0.75) return "landing";
  if (fraction >= 0.5) return "coming-along";
  return "not-yet";
}

export const GET = route({ auth: "PARENT" }, async ({ user, req }) => {
  const asked = req.nextUrl.searchParams.get("studentId");

  let studentId = asked;
  if (!studentId) {
    const active = (await linksForParent(user.id)).filter((l) => l.status === "ACTIVE");
    if (active.length === 0) throw ApiError.forbidden("You do not have access to this.");
    if (active.length > 1) {
      throw ApiError.validation([
        { path: "studentId", message: "is required when more than one link is active" },
      ]);
    }
    studentId = active[0].studentUserId;
  }

  const link = await requireConsentedLink(user.id, studentId);
  const { student, snapshot } = await householdSnapshot(link);
  if (!student) throw ApiError.forbidden("You do not have access to this.");

  return {
    child: {
      id: student.id,
      displayName: student.displayName,
      classNum: student.studentProfile?.classNum ?? null,
      schoolName: student.studentProfile?.schoolName ?? null,
    },
    consent: { grantedAt: link.grantedAt.toISOString() },
    effort: {
      weeks: snapshot.weeks,
      lastActiveMs: snapshot.lastActiveMs,
      lateNightSessions: snapshot.lateNightSessions,
    },
    subjects: snapshot.subjects,
    chapters: snapshot.chapters.map((c) => ({
      bookCode: c.bookCode,
      chapter: c.chapter,
      subject: c.subject,
      label: c.label,
      band: band(c.fraction),
      revisits: c.revisits,
      answersGraded: c.answersGraded,
      lastSeenMs: c.lastSeenMs,
    })),
    pendingHumanReview: snapshot.pendingHumanReview,
    recommendations: recommend(snapshot),
  };
});
