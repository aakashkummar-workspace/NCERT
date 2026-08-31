/**
 * POST /api/dev/login/  — sign in as an existing user, no code required.
 *
 * For the other lanes' curl scripts and smoke tests. It exists so that testing
 * "can an evaluator claim a ticket" does not first require driving an OTP flow
 * that, in development, is a pair of round trips to learn a number this file
 * could have skipped.
 *
 * ## Why this is safe to have in the tree
 *
 * It refuses to run in production, and refuses in two independent ways: the
 * module-level guard below, and the fact that it only ever signs in a user that
 * already exists. It creates nothing and elevates nothing. Even so, treat the
 * `NODE_ENV` check as load-bearing — this route is a total authentication
 * bypass and the only thing standing between it and every account is one
 * comparison.
 *
 * If the deployment story ever gets more complicated than "NODE_ENV is
 * production in production", this whole directory should be deleted from the
 * build rather than guarded harder.
 */
import { ApiError, route, v } from "@/lib/api";
import { devCodeFor, isProduction } from "@/lib/auth";
import prisma from "@/lib/db";
import { PUBLIC_SCOPE_ID, startSession } from "@/lib/session";
import { normalisePhone } from "@/lib/api";

function assertDev(): void {
  if (isProduction()) {
    throw ApiError.notFound("Route");
  }
}

export const POST = route(
  {
    body: v.object({
      phone: v.phone(),
      scopeId: v.optional(v.uuid()),
    }),
  },
  async ({ body }) => {
    assertDev();
    const user = await prisma.user.findUnique({
      where: { scopeId_phone: { scopeId: body.scopeId ?? PUBLIC_SCOPE_ID, phone: body.phone } },
    });
    if (!user) {
      throw ApiError.notFound(
        `No user with phone ${body.phone} in that scope. Run \`npx tsx prisma/seed.ts\``,
      );
    }
    const session = await startSession(user);
    return {
      user: { id: user.id, phone: user.phone, role: user.role, scopeId: user.scopeId, displayName: user.displayName },
      expiresAt: session.expiresAt.toISOString(),
    };
  },
);

/**
 * GET /api/dev/login/?phone=…  — the deterministic OTP for a number, without
 * sending one. Useful when you want to exercise the *real* verify route rather
 * than bypass it.
 */
export const GET = route({}, async ({ req }) => {
  assertDev();
  const raw = req.nextUrl.searchParams.get("phone") ?? "";
  const phone = normalisePhone(raw);
  if (!phone) {
    throw ApiError.validation([{ path: "phone", message: "is not a valid phone number" }]);
  }
  return { phone, code: devCodeFor(phone) };
});
