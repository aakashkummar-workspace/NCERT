/**
 * GET  /api/doubts/   — the doubts this student can see: same scope, same class.
 * POST /api/doubts/   — ask one.
 *
 * Note the trailing slash. `next.config.ts` sets `trailingSlash: true` and that
 * applies to route handlers, so `POST /api/doubts` 308s to `/api/doubts/` and a
 * client that does not re-send the body on a redirect arrives empty-handed.
 * docs/PLATFORM.md §2.
 *
 * `shadow` is the one thing here that comes from the request, and it is not an
 * identity — it is the author's choice about a label. The author itself comes
 * from the session, as it does everywhere. See src/lib/shadow.ts.
 */
import { route, v } from "@/lib/api";
import { listDoubts, postDoubt, MAX_DOUBT_CHARS } from "@/lib/doubts";

export const GET = route({ auth: "STUDENT" }, async ({ req, user }) => {
  const q = req.nextUrl.searchParams;
  const doubts = await listDoubts({
    viewer: user,
    subject: q.get("subject") ?? undefined,
    mine: q.get("mine") === "1",
    unresolvedOnly: q.get("open") === "1",
    limit: Number(q.get("limit")) || undefined,
  });
  return { doubts };
});

export const POST = route(
  {
    auth: "STUDENT",
    idempotent: true,
    body: v.object({
      subject: v.string({ min: 1, max: 60 }),
      text: v.string({ min: 4, max: MAX_DOUBT_CHARS }),
      // Defaults to *off*. A student is never anonymous by accident: if the
      // toggle failed to load, or the field was dropped by a proxy, the safe
      // failure is a signed post they chose to make, not a hidden one they
      // did not.
      shadow: v.withDefault(v.boolean(), false),
    }),
  },
  async ({ user, body, idempotencyKey }) => {
    const doubt = await postDoubt({
      author: user,
      subject: body.subject,
      text: body.text,
      shadow: body.shadow,
      idempotencyKey,
    });
    return { doubt };
  },
);
