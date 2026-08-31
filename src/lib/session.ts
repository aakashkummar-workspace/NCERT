/**
 * Who is making this request.
 *
 * **The rule the whole platform rests on: the acting user and their scope come
 * from here, and from nowhere else.** Not from a `studentId` in the body, not
 * from a `?userId=` in the query, not from an `X-User-Id` header. A route that
 * reads an identity out of the request has handed every one of its users the
 * ability to act as every other one, and no amount of validation downstream
 * recovers from that. `route()` in src/lib/api.ts is built so that the correct
 * thing is also the only thing on offer: it passes `user`, and there is no
 * parameter to override it.
 *
 * ## Why the cookie carries the session rather than pointing at one
 *
 * There is no `sessions` table. `prisma/schema.prisma` is final and scoped to
 * Phases 0–4, and adding one is not this lane's call. So a session is a signed
 * value, not a row: a JSON payload and an HMAC-SHA256 of it under
 * `SESSION_SECRET`. Nothing in it is secret — a user id and a role are not
 * confidential — but nothing in it can be changed either, which is the property
 * that matters.
 *
 * The cost of that choice, stated plainly because whoever adds billing needs to
 * know it: **an issued session cannot be revoked individually.** Signing a user
 * out clears their cookie, which is enough for the person at the keyboard but
 * not for a stolen one. Rotating `SESSION_SECRET` invalidates every session at
 * once, and is the only lever available today. If per-session revocation is
 * ever needed — a "sign out of all devices" button, a compromised account — the
 * fix is a `sessions` table and a `sid` claim, and `getSession()` is the single
 * function that would have to learn to read it.
 *
 * Mitigations that are in place: the cookie is `HttpOnly` (script cannot read
 * it), `SameSite=Lax` (a cross-site form post cannot use it), `Secure` off
 * localhost, and 30 days long rather than indefinite. `requireUser()` re-reads
 * the `users` row on every call, so a deleted user or a changed role takes
 * effect on the next request rather than in 30 days.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { User, UserRole } from "@prisma/client";
import prisma from "@/lib/db";
import { ApiError } from "@/lib/api";

export const SESSION_COOKIE = "ncert_session";

/** 30 days. Long, because signing a Class 9 student out weekly is how you lose them. */
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

/** The nil UUID: the public, B2C scope. See prisma/README.md, "Retrofitting tenancy". */
export const PUBLIC_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * What the cookie actually contains. Short keys because it rides on every
 * request from a phone paying by the megabyte.
 */
interface SessionClaims {
  /** Version. Bump to invalidate every session after a claims change. */
  v: 1;
  /** User id. */
  uid: string;
  /** Scope (tenant) id. */
  sid: string;
  role: UserRole;
  /** Issued at, seconds since epoch. */
  iat: number;
  /** Expires at, seconds since epoch. */
  exp: number;
}

export interface Session {
  userId: string;
  scopeId: string;
  role: UserRole;
  issuedAt: Date;
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Fails loudly in production and falls back to a fixed, obviously-fake string
 * in development.
 *
 * The fallback is deliberate and the value is deliberately recognisable: a
 * developer running `next dev` for the first time should get a working login,
 * not a stack trace about an environment variable. A deployment without a real
 * secret should get the stack trace, because the alternative is every
 * deployment sharing one publicly-known signing key.
 */
function secret(): Buffer {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length >= 16) return Buffer.from(configured, "utf8");
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is unset or shorter than 16 characters. Sessions cannot be signed. See .env.example.",
    );
  }
  return Buffer.from("dev-only-insecure-session-secret", "utf8");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Constant-time compare. A `===` on a MAC leaks its prefix through timing. */
function macEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function encodeSession(claims: SessionClaims): string {
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${sign(payload)}`;
}

/**
 * Returns null for anything that is not a currently-valid session: a malformed
 * token, a bad signature, a wrong claims version, an expired one. Never throws
 * — a stale cookie from an old deploy is a logged-out user, not an error page.
 */
export function decodeSession(token: string | undefined): Session | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!macEquals(mac, sign(payload))) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return null;
  }
  if (claims?.v !== 1 || !claims.uid || !claims.sid || !claims.role) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;

  return {
    userId: claims.uid,
    scopeId: claims.sid,
    role: claims.role,
    issuedAt: new Date(claims.iat * 1000),
    expiresAt: new Date(claims.exp * 1000),
  };
}

// ---------------------------------------------------------------------------
// Reading and writing the cookie
// ---------------------------------------------------------------------------

/**
 * The session as the cookie states it, with no database round trip.
 *
 * Use this when the user id is all you need — logging, a cheap ownership check
 * against a foreign key you are about to filter on anyway. Use `requireUser()`
 * when the *role* decides what happens next, because the role in the cookie is
 * as old as the cookie.
 */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  return decodeSession(jar.get(SESSION_COOKIE)?.value);
}

export interface ResolvedUser {
  user: User;
  session: Session;
}

/**
 * The signed-in user, re-read from the database, or an `ApiError` that
 * `route()` turns into a 401 or a 403.
 *
 * The database read is the point. A cookie issued a fortnight ago says whatever
 * was true a fortnight ago: it will happily claim `ADMIN` for someone
 * demoted since, and claim a user id that has since been deleted. Authorisation
 * decided on a stale claim is not authorisation. One indexed primary-key lookup
 * is a price worth paying for a role that is true right now.
 *
 * `role` is checked against the row, not against the cookie, for the same reason.
 */
export async function requireUser(role?: UserRole | UserRole[]): Promise<ResolvedUser> {
  const session = await getSession();
  if (!session) {
    throw new ApiError("UNAUTHENTICATED", "Sign in to continue.");
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    // The cookie is valid but the user is gone. Deleted account, or a database
    // reset in development. Either way: not signed in.
    throw new ApiError("UNAUTHENTICATED", "Sign in to continue.");
  }

  if (role) {
    const allowed = Array.isArray(role) ? role : [role];
    if (!allowed.includes(user.role)) {
      // Deliberately says nothing about what the resource is or whether it
      // exists. A 403 that distinguishes "not yours" from "not there" is a
      // membership oracle.
      throw ApiError.forbidden("You do not have access to this.");
    }
  }

  return { user, session };
}

/**
 * Mint a session for a user and write the cookie. The *only* place a session is
 * created — the OTP verify route and the development login route both come
 * through here, so there is one definition of what being signed in means.
 */
export async function startSession(user: Pick<User, "id" | "scopeId" | "role">): Promise<Session> {
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    v: 1,
    uid: user.id,
    sid: user.scopeId,
    role: user.role,
    iat: now,
    exp: now + SESSION_MAX_AGE_SEC,
  };

  const jar = await cookies();
  jar.set(SESSION_COOKIE, encodeSession(claims), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });

  return {
    userId: user.id,
    scopeId: user.scopeId,
    role: user.role,
    issuedAt: new Date(claims.iat * 1000),
    expiresAt: new Date(claims.exp * 1000),
  };
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  // Overwrite with an expired empty cookie rather than only calling delete():
  // some proxies drop a bare Set-Cookie deletion, and a cookie that outlives
  // the sign-out button is the one bug users will not forgive.
  jar.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
