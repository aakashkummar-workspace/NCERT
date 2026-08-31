/**
 * POST /api/auth/otp/request/  — send a one-time code, get a challenge back.
 *
 * Public, necessarily: nobody is signed in yet. It answers identically for a
 * number that has an account and one that does not, because the difference is
 * an account-existence oracle and this is the endpoint an attacker would use to
 * ask "is this person's number registered here?".
 *
 * `scopeId` is deliberately not accepted from the body. It is the tenant, and
 * letting a caller name their own tenant is the same class of hole as letting
 * them name their own user. B2C sign-in is always the public scope; when
 * school-branded sign-in lands it resolves the scope from the hostname or an
 * invite token, server-side.
 */
import { route, v } from "@/lib/api";
import { requestOtp } from "@/lib/auth";

export const POST = route(
  { body: v.object({ phone: v.phone() }) },
  async ({ body }) => requestOtp(body.phone),
);
