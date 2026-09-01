/**
 * POST /api/auth/login/  — exchange an email and password for a session cookie.
 *
 * The session is minted by `startSession()`, the same function the OTP verify
 * route and the development login route go through. There is one definition of
 * being signed in and this is not a second one.
 *
 * Every failure — unknown address, an address that exists but has only ever
 * used a code, and the right address with the wrong password — returns the same
 * 401 with the same wording. Anything else is an account-existence oracle, and
 * whether a given person uses this platform is nobody's business.
 *
 * Attempts are rate-limited per identifier in `src/lib/auth.ts`, on the same
 * in-process counter the OTP send limit uses — and with the same honest caveat:
 * it resets on deploy and does not span instances. See docs/PLATFORM.md §7.
 */
import { route, v } from "@/lib/api";
import { PASSWORD_MAX_LENGTH, loginWithPassword } from "@/lib/auth";
import { startSession } from "@/lib/session";

export const POST = route(
  {
    body: v.object({
      email: v.string({ min: 6, max: 255 }),
      // Not trimmed, and not floored at PASSWORD_MIN_LENGTH. A minimum here
      // would answer "is this address's password shorter than ten characters?"
      // for free, and an old account may hold one that today's rules would
      // refuse. Signing in checks the password, not the policy.
      password: v.string({ min: 1, max: PASSWORD_MAX_LENGTH, trim: false }),
    }),
  },
  async ({ body }) => {
    const user = await loginWithPassword({ email: body.email, password: body.password });
    const session = await startSession(user);
    return {
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        displayName: user.displayName,
        role: user.role,
        scopeId: user.scopeId,
      },
      expiresAt: session.expiresAt.toISOString(),
    };
  },
);
