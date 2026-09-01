/**
 * The link between a parent and a student: asking for one, and seeing them.
 *
 *   POST /api/parent/links/   { studentPhone }   PARENT — ask
 *   GET  /api/parent/links/                      anyone — what exists
 *
 * A request discloses nothing. The POST answers **identically** whether the
 * number matched a student or matched nobody: "no account with that number" is
 * an account-existence oracle, and docs/PLATFORM.md already refuses to give one
 * on the OTP route. No count is returned either — "2 children found" is the
 * same oracle with a number on it.
 *
 * Nothing about the student is returned until they have granted consent. Until
 * then a parent sees a row that says "waiting", and not so much as a name.
 *
 * ## The household number is the join
 *
 * `prisma/seed.ts` seeds two siblings sharing their parent's number across two
 * scopes — the case `@@unique([scopeId, phone])` exists to permit. So the
 * lookup is by phone **across scopes**, and one POST with that number puts a
 * request in front of both siblings, each of whom answers for themselves.
 *
 * Reading across scopes here is safe in a way that an admin query never is: the
 * result is not returned, only acted on, and the action produces a request that
 * the student must approve. Scope still governs everything an admin reads.
 *
 * ## Known gap: a narrow existence oracle
 *
 * The POST response leaks nothing, but a parent's own `GET` shows a PENDING row
 * only when the number matched somebody — so a parent account can probe whether
 * a given number belongs to a student here. The fix needs a column this lane
 * does not have: record the request against the *number asked about* rather
 * than against the resolved user, so an unmatched request is stored and
 * displayed identically, and connects itself if that number later signs up.
 * That is `requestedPhone` on the `ParentLink` model described in
 * src/lib/parent.ts. There is no rate limit here either; when one is added it
 * belongs beside the OTP counters in src/lib/auth.ts, which have the same gap.
 */
import { route, v } from "@/lib/api";
import prisma from "@/lib/db";
import { linksForParent, linksForStudent, requestLink } from "@/lib/parent";

/** A household number can reasonably be shared by siblings, not by a class. */
const MAX_MATCHES = 5;

export const POST = route(
  {
    auth: "PARENT",
    idempotent: true,
    body: v.object({ studentPhone: v.phone() }),
  },
  async ({ user, body, idempotencyKey }) => {
    const students = await prisma.user.findMany({
      where: { phone: body.studentPhone, role: "STUDENT" },
      select: { id: true, scopeId: true },
      orderBy: { createdAt: "asc" },
      take: MAX_MATCHES,
    });

    for (const student of students) {
      // A parent cannot be their own child, and a self-link would be a way to
      // hand yourself a dashboard by owning two accounts on one number.
      if (student.id === user.id) continue;
      await requestLink({
        parentUserId: user.id,
        studentUserId: student.id,
        studentScopeId: student.scopeId,
        idempotencyKey,
      });
    }

    // Constant response. Deliberately no count and no ids.
    return {
      ok: true,
      message:
        "If that number belongs to a student here, they will see your request the next time they open the app. They decide.",
    };
  },
);

export const GET = route({ auth: "any" }, async ({ user }) => {
  if (user.role === "PARENT") {
    const links = await linksForParent(user.id);
    const activeIds = links.filter((l) => l.status === "ACTIVE").map((l) => l.studentUserId);

    // Names are fetched only for links the student has actually granted. A
    // pending request resolves to nothing at all — not a name, not a class, not
    // a school. Consent gates the query, not the rendering.
    const children = activeIds.length
      ? await prisma.user.findMany({
          where: { id: { in: activeIds } },
          select: {
            id: true,
            displayName: true,
            studentProfile: { select: { classNum: true } },
          },
        })
      : [];
    const byId = new Map(children.map((c) => [c.id, c]));

    return {
      role: user.role,
      children: links
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
        .map((l) => {
          const child = byId.get(l.studentUserId);
          return {
            studentUserId: l.studentUserId,
            status: l.status,
            requestedAt: l.requestedAt.toISOString(),
            decidedAt: l.decidedAt?.toISOString() ?? null,
            displayName: child?.displayName ?? null,
            classNum: child?.studentProfile?.classNum ?? null,
          };
        }),
    };
  }

  if (user.role === "STUDENT") {
    const links = await linksForStudent(user.id);
    const parentIds = links.map((l) => l.parentUserId);
    // The one place a phone number is selected on a parent path — and it runs
    // *student-ward*, never the other way. A student being asked to hand over
    // their schoolwork has to be able to tell who is asking, and a display name
    // alone is not identification. Only the last four digits are returned.
    const parents = parentIds.length
      ? await prisma.user.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, displayName: true, phone: true },
        })
      : [];
    const byId = new Map(parents.map((p) => [p.id, p]));

    return {
      role: user.role,
      requests: links
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
        .map((l) => {
          const parent = byId.get(l.parentUserId);
          return {
            parentUserId: l.parentUserId,
            displayName: parent?.displayName ?? null,
            // `phone` is nullable since email + password sign-in landed: an
            // account created that way has no number to hint at. Null here, and
            // ConsentGate already renders the no-hint case.
            phoneHint: parent?.phone ? `•••••${parent.phone.slice(-4)}` : null,
            status: l.status,
            requestedAt: l.requestedAt.toISOString(),
            decidedAt: l.decidedAt?.toISOString() ?? null,
            // The whole sequence, so a parent who asks again after being
            // refused is visible to the person refusing.
            history: l.history.map((e) => ({ at: e.at, type: e.type })),
          };
        }),
    };
  }

  return { role: user.role, children: [], requests: [] };
});
