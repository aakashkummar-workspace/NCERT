/**
 * Phone-first identity, and the OTP flow that establishes it.
 *
 * A Class 9 student in India routinely has no email address and no intention of
 * getting one — the schema says so, and it is why `User.phone` is the
 * identifier. So there is no password anywhere in this file. A password is a
 * thing to forget, to reset over an email account that does not exist, and to
 * reuse; a one-time code to the number the account *is* skips all three.
 *
 * ## No SMS provider exists, and this file does not invent one
 *
 * `sendOtp()` in development does not send anything. It prints the code to the
 * server log and returns it in the response, and both of those are gated on
 * `NODE_ENV !== "production"`. When a provider is chosen, `deliverOtp()` below
 * is the single function that changes; nothing else in the flow knows how a
 * code travels.
 *
 * The development code is *deterministic* — derived from the phone number, not
 * random — so that a test script, a teammate's curl, and a rerun after a
 * restart all agree on it without anyone having to read a log. That is a
 * development affordance and a production catastrophe, which is why
 * `devCodeFor()` refuses to compute anything in production.
 *
 * ## Why the challenge is a signed token and not a row
 *
 * Same reason as sessions: `prisma/schema.prisma` is final and has no table for
 * a pending OTP. So `requestOtp()` returns an opaque signed `challenge` that
 * carries the phone, a hash of the code, and an expiry. `verifyOtp()` checks
 * the code against the hash inside it.
 *
 * The honest cost, because whoever hardens this needs it in one place:
 *
 * - **Attempt-count limiting is best-effort.** The counters below live in
 *   process memory, so they reset on deploy and do not span instances. A
 *   6-digit code with an unbounded attempt budget falls in well under a
 *   million tries. Before this is exposed to the internet it needs a shared
 *   store — Redis, or an `otp_challenges` table — and `consumeAttempt()` is the
 *   one function that has to learn about it.
 * - **A challenge is not single-use across processes.** The same memory caveat.
 * - **Send-rate limiting is per process too.** An SMS provider bills per
 *   message; a public unlimited `POST /api/auth/otp/request` is somebody else's
 *   budget being spent.
 *
 * These are noted rather than fixed because fixing them means picking
 * infrastructure, and picking infrastructure is not this lane's call.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { User, UserRole } from "@prisma/client";
import prisma from "@/lib/db";
import { ApiError, normalisePhone } from "@/lib/api";
import { PUBLIC_SCOPE_ID } from "@/lib/session";

/** Five minutes. Long enough for an SMS on a bad network, short enough to matter. */
export const OTP_TTL_SEC = 5 * 60;
export const OTP_LENGTH = 6;
/** Wrong guesses allowed against one challenge before it is dead. */
export const OTP_MAX_ATTEMPTS = 5;
/** Codes one phone may request per window, and the window. */
export const OTP_MAX_SENDS = 5;
export const OTP_SEND_WINDOW_SEC = 15 * 60;

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

// ---------------------------------------------------------------------------
// The challenge token
// ---------------------------------------------------------------------------

interface ChallengeClaims {
  v: 1;
  /** E.164 phone the code was sent to. */
  p: string;
  /** Scope the sign-in is for. */
  s: string;
  /** HMAC of the code, so the token does not carry the code itself. */
  h: string;
  /** Nonce — makes two challenges for the same phone and code distinct. */
  n: string;
  exp: number;
}

function secret(): Buffer {
  const configured = process.env.OTP_SECRET ?? process.env.SESSION_SECRET;
  if (configured && configured.length >= 16) return Buffer.from(configured, "utf8");
  if (isProduction()) {
    throw new Error("OTP_SECRET (or SESSION_SECRET) is unset. OTP challenges cannot be signed.");
  }
  return Buffer.from("dev-only-insecure-otp-secret", "utf8");
}

function mac(input: string): string {
  return createHmac("sha256", secret()).update(input).digest("base64url");
}

function equals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function encodeChallenge(claims: ChallengeClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

function decodeChallenge(token: string): ChallengeClaims | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!equals(token.slice(dot + 1), mac(payload))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ChallengeClaims;
    if (claims?.v !== 1 || !claims.p || !claims.h) return null;
    if (claims.exp * 1000 <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** The code is never stored, only its keyed hash, bound to phone and nonce. */
function hashCode(phone: string, nonce: string, code: string): string {
  return mac(`otp:${phone}:${nonce}:${code}`);
}

// ---------------------------------------------------------------------------
// Best-effort, in-process rate limiting
// ---------------------------------------------------------------------------

const attempts = new Map<string, number>();
const sends = new Map<string, { count: number; resetAt: number }>();

function consumeAttempt(challengeMac: string): void {
  const used = (attempts.get(challengeMac) ?? 0) + 1;
  attempts.set(challengeMac, used);
  if (used > OTP_MAX_ATTEMPTS) {
    throw new ApiError("RATE_LIMITED", "Too many incorrect codes. Request a new one.");
  }
}

function consumeSend(phone: string): void {
  const now = Date.now();
  const entry = sends.get(phone);
  if (!entry || entry.resetAt <= now) {
    sends.set(phone, { count: 1, resetAt: now + OTP_SEND_WINDOW_SEC * 1000 });
    return;
  }
  entry.count += 1;
  if (entry.count > OTP_MAX_SENDS) {
    throw new ApiError("RATE_LIMITED", "Too many codes requested. Try again in a few minutes.");
  }
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * The development code for a phone: six digits, stable, derived from the number
 * under the local secret.
 *
 * Refuses outright in production. This is not caution about a misconfigured
 * flag — it is that a deterministic OTP is not an OTP, and the failure mode of
 * getting this wrong is that every account on the platform is opened by anyone
 * who can read this file.
 */
export function devCodeFor(phone: string): string {
  if (isProduction()) {
    throw new Error("devCodeFor() must never run in production.");
  }
  const digest = createHmac("sha256", secret()).update(`devotp:${phone}`).digest();
  const n = digest.readUInt32BE(0) % 10 ** OTP_LENGTH;
  return String(n).padStart(OTP_LENGTH, "0");
}

function generateCode(phone: string): string {
  if (isProduction()) {
    return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
  }
  return devCodeFor(phone);
}

/**
 * The seam an SMS provider slots into, and the only thing that changes when one
 * is chosen. Everything above and below it is provider-agnostic.
 */
async function deliverOtp(phone: string, code: string): Promise<void> {
  if (isProduction()) {
    // No provider is configured, and this file must not add one. Failing here
    // is correct: silently not sending a code, while returning 200, would look
    // like a working sign-in that never arrives.
    throw new ApiError(
      "NOT_AVAILABLE",
      "SMS delivery is not configured on this deployment.",
    );
  }
  console.log(
    `\n  ┌─ OTP ────────────────────────────────────\n` +
      `  │  ${phone}\n` +
      `  │  code: ${code}   (valid ${OTP_TTL_SEC / 60} min)\n` +
      `  └──────────────────────────────────────────\n`,
  );
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export interface OtpChallenge {
  challenge: string;
  expiresInSec: number;
  /** Development only. Absent in production, where it would be the whole hole. */
  devCode?: string;
}

/**
 * Step one: send a code, return an opaque challenge.
 *
 * Deliberately does **not** say whether the phone belongs to an existing
 * account. "No account with that number" turns this endpoint into a way to test
 * whether a given person uses the platform, and the answer is nobody's business.
 * The account is created, if it needs to be, at verify time.
 */
export async function requestOtp(rawPhone: string, scopeId = PUBLIC_SCOPE_ID): Promise<OtpChallenge> {
  const phone = normalisePhone(rawPhone);
  if (!phone) {
    throw ApiError.validation([{ path: "phone", message: "is not a valid phone number" }]);
  }
  consumeSend(phone);

  const code = generateCode(phone);
  const nonce = randomInt(0, 2 ** 31).toString(36);
  const claims: ChallengeClaims = {
    v: 1,
    p: phone,
    s: scopeId,
    h: hashCode(phone, nonce, code),
    n: nonce,
    exp: Math.floor(Date.now() / 1000) + OTP_TTL_SEC,
  };

  await deliverOtp(phone, code);

  return {
    challenge: encodeChallenge(claims),
    expiresInSec: OTP_TTL_SEC,
    ...(isProduction() ? {} : { devCode: code }),
  };
}

export interface VerifiedIdentity {
  user: User;
  /** True when this verification created the account. */
  isNewUser: boolean;
}

/**
 * Step two: check the code, then find or create the user.
 *
 * ## `role` is not a parameter, and that is the point
 *
 * A caller cannot choose what they sign up as. Every account created here is a
 * `STUDENT`. `EVALUATOR` and `ADMIN` are provisioned — by the seed, or by an
 * admin-only route some later lane writes — never claimed. A sign-up endpoint
 * that honours a `role` field in the request body is a one-line path from
 * anonymous to administrator, and it is a mistake that gets made because the
 * field looks like data rather than like a privilege.
 *
 * `displayName` and `classNum` are safe to accept: they are facts about the
 * person, not permissions over other people.
 */
export async function verifyOtp(input: {
  challenge: string;
  code: string;
  displayName?: string;
  classNum?: number;
}): Promise<VerifiedIdentity> {
  const claims = decodeChallenge(input.challenge);
  if (!claims) {
    throw new ApiError("UNAUTHENTICATED", "That code has expired. Request a new one.");
  }

  const challengeMac = input.challenge.slice(input.challenge.indexOf(".") + 1);
  consumeAttempt(challengeMac);

  const expected = claims.h;
  const supplied = hashCode(claims.p, claims.n, input.code.trim());
  if (!equals(expected, supplied)) {
    throw new ApiError("UNAUTHENTICATED", "That code is not correct.");
  }
  attempts.delete(challengeMac);

  const existing = await prisma.user.findUnique({
    where: { scopeId_phone: { scopeId: claims.s, phone: claims.p } },
  });
  if (existing) {
    // A returning student may still be filling in a name they skipped. Never
    // overwrite one that is already set with a blank.
    if (input.displayName && !existing.displayName) {
      const updated = await prisma.user.update({
        where: { id: existing.id },
        data: { displayName: input.displayName },
      });
      return { user: updated, isNewUser: false };
    }
    return { user: existing, isNewUser: false };
  }

  const role: UserRole = "STUDENT";
  const user = await prisma.user.create({
    data: {
      scopeId: claims.s,
      phone: claims.p,
      role,
      displayName: input.displayName ?? null,
      studentProfile: {
        // Class 10 is the default because it is the class with the board exam,
        // and so the one a new arrival most often is. It is a profile field the
        // student can change, not a claim about them we act on irreversibly.
        create: { classNum: input.classNum ?? 10 },
      },
    },
  });
  return { user, isNewUser: true };
}
