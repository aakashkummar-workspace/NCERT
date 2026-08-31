/**
 * POST /api/auth/logout/  — clear the cookie.
 *
 * POST rather than GET because a GET logout is triggerable by any `<img>` tag
 * on any page the user visits, and being silently signed out mid-exam is a real
 * cost. It does not require a session: signing out twice, or signing out an
 * already-expired session, should succeed quietly rather than 401.
 */
import { route } from "@/lib/api";
import { endSession } from "@/lib/session";

export const POST = route({}, async () => {
  await endSession();
  return { ok: true };
});
