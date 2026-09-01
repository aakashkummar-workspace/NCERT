/**
 * POST /api/auth/register/  — create an account with an email and a password.
 *
 * The second way in, next to the OTP flow rather than instead of it. It exists
 * because there is no SMS provider: `deliverOtp()` throws in production, so on
 * a real deployment the phone-first flow cannot let anybody in at all.
 *
 * ## It answers the same thing whether or not the address is taken
 *
 * Always `201 { ok: true }`. Not "that email is already registered", not a
 * 409, not a different latency — `registerWithPassword()` hashes before it
 * writes and swallows the unique violation, so the two paths do the same work
 * and return the same bytes. "Already registered" is a helpful message and a
 * list of everyone who uses the platform; `POST /api/auth/otp/request/`
 * already refuses to be that oracle from the phone side and this must not
 * reopen it from the email side.
 *
 * The cost is that registration cannot sign you in — if the address existed,
 * the session would belong to somebody else. So the client registers and then
 * calls `POST /api/auth/login/`, which is one extra round trip and no extra
 * step for the person typing.
 *
 * ## What is not in the body
 *
 * `scopeId`, `hitlEnabled`, `userId`. Each is a privilege, and a privilege
 * accepted from a request body is a privilege granted to anyone with curl.
 * B2C sign-up is always the public scope.
 *
 * `role` is the interesting one: it is in the body **only outside production**,
 * so the owner can hold a student, an evaluator, a parent and an admin account
 * without four admin-only routes existing first. That is gated the way
 * `src/app/api/dev/login/route.ts` gates itself — twice, independently:
 *
 *   1. `bodyValidator()` below builds a validator with no `role` field at all
 *      when `NODE_ENV === "production"`. `v.object` only reads declared keys,
 *      so a posted `{"role":"ADMIN"}` is not parsed, not passed on, and not
 *      seen.
 *   2. `registerWithPassword()` re-checks `isProduction()` itself and pins
 *      `STUDENT` before it looks at the field, so calling the function
 *      directly does not get you past this either.
 *
 * Either alone would do. Both are here because the failure mode is anonymous
 * to administrator in one line, and one comparison is a thin thing to hang
 * that on.
 */
import { NextResponse } from "next/server";
import { route, v } from "@/lib/api";
import type { Validator } from "@/lib/api";
import { PASSWORD_MAX_LENGTH, isProduction, registerWithPassword } from "@/lib/auth";
import type { UserRole } from "@prisma/client";

interface RegisterBody {
  email: string;
  password: string;
  displayName?: string;
  classNum?: number;
  role?: UserRole;
}

/** Gate one: in production the `role` key does not exist on the shape. */
function bodyValidator(): Validator<RegisterBody> {
  const common = {
    email: v.string({ min: 6, max: 255 }),
    // `trim: false` — a password's leading and trailing spaces are part of it.
    // Trimming here and not at sign-in is how a password stops working the day
    // after it was set.
    password: v.string({ min: 1, max: PASSWORD_MAX_LENGTH, trim: false }),
    displayName: v.optional(v.string({ min: 1, max: 120 })),
    classNum: v.optional(v.int({ min: 9, max: 10 })),
  };
  if (isProduction()) {
    return v.object(common) as Validator<RegisterBody>;
  }
  return v.object({
    ...common,
    role: v.optional(v.enumOf(["STUDENT", "EVALUATOR", "PARENT", "ADMIN"] as const)),
  }) as Validator<RegisterBody>;
}

export const POST = route({ body: bodyValidator() }, async ({ body }) => {
  await registerWithPassword({
    email: body.email,
    password: body.password,
    displayName: body.displayName,
    classNum: body.classNum,
    role: body.role,
  });
  // Deliberately does not report whether a row was written. `created` is the
  // one bit that would make this an oracle.
  return NextResponse.json({ ok: true }, { status: 201 });
});
