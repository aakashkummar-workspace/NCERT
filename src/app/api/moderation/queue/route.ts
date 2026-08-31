/**
 * GET /api/moderation/queue/  — everything reported and not yet dealt with.
 *
 * `ADMIN`, and `requireUser("ADMIN")` re-reads the row, so an account demoted
 * five minutes ago is refused rather than carried by a cookie issued a
 * fortnight back. docs/PLATFORM.md §1.
 *
 * The queue is scoped: an admin is an admin *of a scope*, not of the platform.
 * The filter is on the reported post's author, applied inside
 * `moderationQueue()`.
 *
 * It shows pseudonyms, not names. Identity is a separate, audited request —
 * see `/api/moderation/<id>/author/`.
 */
import { route } from "@/lib/api";
import { moderationQueue } from "@/lib/moderation";

export const GET = route({ auth: "ADMIN" }, async ({ req, user }) => {
  const q = req.nextUrl.searchParams;
  const items = await moderationQueue({
    moderator: user,
    includeHandled: q.get("all") === "1",
    limit: Number(q.get("limit")) || undefined,
  });
  return { items, scopeId: user.scopeId };
});
