/**
 * POST /api/parent/accounts/ — provision a parent account. ADMIN only.
 *
 * ## Why this is not a sign-up field
 *
 * docs/PLATFORM.md §1: a new account is always `STUDENT`, and a role accepted
 * from a request body is a one-line path from anonymous to administrator. So
 * `PARENT` is provisioned behind `requireUser("ADMIN")`, like `EVALUATOR`.
 *
 * ## The decision this route does not make, and should not make alone
 *
 * `PARENT` is an unusual role in that it carries **no privilege of its own**.
 * A parent with no consented link can read nothing; every query in
 * `src/lib/parent.ts` needs a `ConsentedLink`, and only a student can produce
 * one. That is a real argument that parents could safely self-declare at
 * sign-up, the way they cannot for `EVALUATOR` — the gate is the student's
 * consent, not the role.
 *
 * It is left as an admin route anyway, because the argument depends on every
 * future reader of `role === "PARENT"` also knowing it confers nothing, and
 * that is exactly the kind of invariant that decays. If B2C parent self-service
 * is wanted, the change is a deliberate one — a `role: "PARENT"` branch in
 * `verifyOtp` plus a note in docs/PLATFORM.md §1 — and not something this lane
 * slipped in.
 *
 * The account is created in the **admin's own scope**, never one named in the
 * body. A parent's link then reaches across scopes if their children are
 * elsewhere: consent, not scope, is what authorises a parent read, because a
 * household routinely straddles a school tenant and the public one.
 */
import { ApiError, createOnce, route, v } from "@/lib/api";
import prisma from "@/lib/db";

export const POST = route(
  {
    auth: "ADMIN",
    idempotent: true,
    body: v.object({
      phone: v.phone(),
      displayName: v.optional(v.string({ max: 120 })),
    }),
  },
  async ({ user, body }) => {
    const existing = await prisma.user.findUnique({
      where: { scopeId_phone: { scopeId: user.scopeId, phone: body.phone } },
    });

    if (existing) {
      if (existing.role === "PARENT") {
        // Idempotent: provisioning the same parent twice is provisioning them once.
        return { parentUserId: existing.id, created: false };
      }
      // Never silently re-role a student into a parent: their attempts,
      // submissions and grades hang off that row, and a student who becomes a
      // parent overnight is a student whose own work is now somebody else's
      // dashboard.
      throw new ApiError(
        "CONFLICT",
        "That number already belongs to an account with a different role in this scope.",
      );
    }

    const { row, created } = await createOnce({
      constraint: "phone",
      create: () =>
        prisma.user.create({
          data: {
            scopeId: user.scopeId,
            phone: body.phone,
            displayName: body.displayName ?? null,
            role: "PARENT",
          },
        }),
      find: () =>
        prisma.user.findUnique({
          where: { scopeId_phone: { scopeId: user.scopeId, phone: body.phone } },
        }),
    });

    return { parentUserId: row.id, created };
  },
);
