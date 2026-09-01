/**
 * Phone-first identity, and the OTP flow that establishes it.
 *
 * A Class 9 student in India routinely has no email address and no intention of
 * getting one — the schema says so, and it is why `User.phone` is the
 * identifier. A password is a thing to forget, to reset over an email account
 * that does not exist, and to reuse; a one-time code to the number the account
 * *is* skips all three. That argument has not changed and OTP is still the
 * front door.
 *
 * What changed is that the back door was bricked up. There is no SMS provider,
 * `deliverOtp()` throws in production, and so on a real deployment the OTP flow
 * cannot let anybody in at all. An identity system nobody can use is not a
 * safer identity system. So this file grew a second way in — email and
 * password — **alongside** the first, not instead of it: `phone`, `email` and
 * `passwordHash` are all nullable, a user may have any subset of them so long
 * as they have at least one identifier (the `user_has_identifier` CHECK), and
 * an account created by OTP is untouched by any of it.
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
import { createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { User, UserRole } from "@prisma/client";
import prisma from "@/lib/db";
import { ApiError, isUniqueViolation, normalisePhone } from "@/lib/api";
import { PUBLIC_SCOPE_ID } from "@/lib/session";

/** Five minutes. Long enough for an SMS on a bad network, short enough to matter. */
export const OTP_TTL_SEC = 5 * 60;
export const OTP_LENGTH = 6;
/** Wrong guesses allowed against one challenge before it is dead. */
export const OTP_MAX_ATTEMPTS = 5;
/** Codes one phone may request per window, and the window. */
export const OTP_MAX_SENDS = 5;
export const OTP_SEND_WINDOW_SEC = 15 * 60;

/**
 * Short enough that a Class 9 student will actually pick one, long enough that
 * guessing it offline is not the cheap attack. There is no strength meter here
 * on purpose: a meter teaches people to append `1!` to a word, and the length
 * floor plus the small refusal list below buys most of what one would.
 */
export const PASSWORD_MIN_LENGTH = 10;
/** Not a security limit — a denial-of-service one. scrypt hashes what it is given. */
export const PASSWORD_MAX_LENGTH = 200;
/** Failed sign-ins allowed per identifier per window. */
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_SEC = 15 * 60;

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

interface CounterWindow {
  count: number;
  resetAt: number;
}

/** Codes sent, per phone. */
const sends = new Map<string, CounterWindow>();
/** Failed password sign-ins, per scoped email. */
const logins = new Map<string, CounterWindow>();

function consumeAttempt(challengeMac: string): void {
  const used = (attempts.get(challengeMac) ?? 0) + 1;
  attempts.set(challengeMac, used);
  if (used > OTP_MAX_ATTEMPTS) {
    throw new ApiError("RATE_LIMITED", "Too many incorrect codes. Request a new one.");
  }
}

/**
 * One fixed-window counter, used by every rate limit in this file.
 *
 * Extracted rather than copied: password sign-in needs exactly what OTP sending
 * already had, and a second hand-rolled counter would be a second thing to fix
 * when these move to a shared store. They still have to move — see the header
 * note. `consumeWindowed()` is now the single function that learns about Redis.
 */
function consumeWindowed(
  bucket: Map<string, CounterWindow>,
  key: string,
  max: number,
  windowSec: number,
  message: string,
): void {
  const now = Date.now();
  const entry = bucket.get(key);
  if (!entry || entry.resetAt <= now) {
    bucket.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return;
  }
  entry.count += 1;
  if (entry.count > max) {
    throw new ApiError("RATE_LIMITED", message);
  }
}

function consumeSend(phone: string): void {
  consumeWindowed(
    sends,
    phone,
    OTP_MAX_SENDS,
    OTP_SEND_WINDOW_SEC,
    "Too many codes requested. Try again in a few minutes.",
  );
}

/**
 * Counted per identifier, and — this is the part that matters — counted on
 * *every* attempt rather than only on ones that found a user. A limiter that
 * skips unknown addresses is itself an oracle: the attacker learns which
 * addresses exist by watching which ones can be hammered forever.
 */
function consumeLogin(key: string): void {
  consumeWindowed(
    logins,
    key,
    LOGIN_MAX_ATTEMPTS,
    LOGIN_WINDOW_SEC,
    "Too many sign-in attempts. Try again in a few minutes.",
  );
}

/** Cleared on a correct password, so an honest typo run does not lock a person out. */
function clearLogin(key: string): void {
  logins.delete(key);
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

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * scrypt, from `node:crypto`, and nothing else.
 *
 * There is no bcrypt and no argon2 here, and adding one was not on the table —
 * docs/PLATFORM.md §8 says as much and this lane is not the exception. scrypt
 * is memory-hard, is in the standard library of every Node this app runs on,
 * and at these parameters costs roughly 100 ms and 16 MB per hash: slow enough
 * that a stolen table is expensive to grind, fast enough that a sign-in on a
 * cheap VPS is not a visible pause.
 *
 * ## The stored string describes itself
 *
 * `scrypt$N$r$p$dkLen$salt$hash`, salt and hash base64url:
 *
 *     scrypt$16384$8$1$64$3Qk1…$9fZa…
 *
 * The parameters are in the row, not in this file, because the whole point of a
 * cost parameter is that it goes up. When N is raised, every existing row still
 * verifies against the N it was written with — `verifyPassword()` reads the
 * parameters out of the string it was given and never assumes the current ones.
 * A bare hex digest would have made that a guessing game, and the usual outcome
 * of that guessing game is that nobody ever raises the cost.
 *
 * The salt is per user and random, so two people with the same password have
 * different hashes and one precomputed table buys nothing.
 */
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, dkLen: 64 } as const;
const SALT_BYTES = 16;

/** 128 · N · r is scrypt's working set; Node's 32 MB default would refuse a raise. */
function maxmemFor(N: number, r: number, p: number): number {
  return 256 * N * r + 128 * r * p + 1024 * 1024;
}

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, dkLen } = SCRYPT_PARAMS;
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, dkLen, { N, r, p, maxmem: maxmemFor(N, r, p) });
  return [
    "scrypt",
    N,
    r,
    p,
    dkLen,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Constant-time, and false rather than throwing for anything it cannot parse.
 *
 * `timingSafeEqual` is the point: a `===` on two hashes leaks how much of the
 * prefix matched, and a byte-at-a-time oracle turns an offline problem into an
 * online one.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, dkRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  const dkLen = Number(dkRaw);
  if (![N, r, p, dkLen].every((n) => Number.isInteger(n) && n > 0)) return false;
  // A row is not allowed to ask this process for an unbounded allocation.
  if (N > 1 << 20 || r > 32 || p > 16 || dkLen > 128) return false;

  const expected = Buffer.from(hashRaw, "base64url");
  if (expected.length !== dkLen) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, Buffer.from(saltRaw, "base64url"), dkLen, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r, p),
    });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

/**
 * A real hash of a password nobody has, verified against on the paths where
 * there is no user — so an unknown address costs the same ~100 ms as a known
 * one. Without it, "no such account" returns in a millisecond and the response
 * time is the account-existence oracle that the identical *wording* was meant
 * to close.
 */
const ABSENT_USER_HASH = hashPassword(randomBytes(32).toString("base64url"));

async function burnPasswordTime(password: string): Promise<void> {
  await verifyPassword(password, await ABSENT_USER_HASH);
}

/**
 * The short refusal list. Not a strength meter — a strength meter is a bar that
 * teaches people to append `1!`. This rejects the handful of strings that show
 * up first in every credential-stuffing list, plus a password that is just the
 * address it signs in with.
 */
const REFUSED = new Set([
  "password12",
  "password123",
  "password1234",
  "qwerty12345",
  "1234567890",
  "12345678901",
  "123456789012",
  "iloveyou12",
  "letmein123",
  "welcome123",
  "admin12345",
  "ncertquick",
]);

/** `null` when the password is acceptable; otherwise the reason, in the app's voice. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  const lower = password.toLowerCase();
  if (REFUSED.has(lower)) return "is one of the first passwords anyone guesses";
  if (new Set(lower).size < 4) return "repeats too few characters";
  if (email) {
    const address = email.toLowerCase();
    if (lower === address || lower === address.split("@")[0]) return "cannot be your email address";
  }
  return null;
}

/**
 * Lowercased and trimmed, or `null`.
 *
 * The same job `normalisePhone()` does, for the same reason: the database will
 * not case-fold for you, so `Aarti@x.com` and `aarti@x.com` would be two
 * accounts under `@@unique([scopeId, email])`. Deliberately not an RFC 5322
 * parser — that grammar admits things no mail server accepts, and this only has
 * to reject a typo before it becomes an account nobody can sign in to.
 */
export function normaliseEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length < 6 || email.length > 255) return null;
  if (!/^[^\s@",;:<>]+@[^\s@.",;:<>]+(\.[^\s@.",;:<>]+)+$/.test(email)) return null;
  return email;
}

// ---------------------------------------------------------------------------
// Email + password sign-in
// ---------------------------------------------------------------------------

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string;
  classNum?: number;
  /** Ignored in production, always. See below. */
  role?: UserRole;
  scopeId?: string;
}

export interface RegisterResult {
  /**
   * Whether a row was written. **Never put this in a response body.** It is the
   * one bit of information that would turn registration into an
   * account-existence oracle; it exists for the seed and for tests.
   */
  created: boolean;
}

/**
 * Create an account, or quietly do nothing because the address is taken.
 *
 * ## Why this returns so little, and never a session
 *
 * A registration endpoint is the easiest account-existence oracle to build by
 * accident: "that email is already registered" is a helpful message and a list
 * of everybody who uses the platform. `POST /api/auth/otp/request/` already
 * refuses to be one; this must not undo that from the other side.
 *
 * So the address being taken is not an error, not a different status code, and
 * not a different response — it is *nothing*. The caller registers, gets the
 * same answer either way, and then signs in. If the address was already
 * somebody's, the sign-in fails with the same generic message a wrong password
 * gets, and the attacker has learnt one thing: that they do not have the
 * password. Which they already knew.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - **Registration never signs you in.** It cannot: if the address existed, the
 *   session it minted would belong to somebody else. `SignInForm` calls login
 *   straight afterwards, which is the same round trip from the user's side.
 * - **Nothing is read before it is written.** The password is hashed first, then
 *   the insert either succeeds or trips `users_scopeId_email_key`. A
 *   read-then-write would be both a race and a shortcut past the constant work
 *   above — docs/PLATFORM.md §5 argues the first half of that already.
 *
 * ## The role
 *
 * In production every account created here is a `STUDENT`, exactly as
 * `verifyOtp()` guarantees, and `role` is not read at all. Outside production
 * it is honoured, so that the owner can be a student, an evaluator, a parent
 * and an admin without four admin-only routes existing first.
 *
 * That convenience is gated the way `src/app/api/dev/login/route.ts` is gated:
 * in two places that do not depend on each other. Here, `isProduction()`
 * forces `STUDENT` before the value is looked at. In the route, the body
 * validator is built without a `role` field at all when in production, so there
 * is no parsed value to pass. Either one alone is sufficient; both exist
 * because "a role accepted from a request body is a one-line path from
 * anonymous to administrator" and one comparison is a thin thing to hang that
 * on.
 */
export async function registerWithPassword(input: RegisterInput): Promise<RegisterResult> {
  const scopeId = input.scopeId ?? PUBLIC_SCOPE_ID;
  const email = normaliseEmail(input.email);
  if (!email) {
    throw ApiError.validation([{ path: "email", message: "is not a valid email address" }]);
  }
  const problem = passwordProblem(input.password, email);
  if (problem) {
    throw ApiError.validation([{ path: "password", message: problem }]);
  }

  // Gate one. Evaluated before `input.role` is touched, so there is no branch
  // in which a production request reaches the value.
  const role: UserRole = isProduction() ? "STUDENT" : (input.role ?? "STUDENT");

  const passwordHash = await hashPassword(input.password);

  try {
    await prisma.user.create({
      data: {
        scopeId,
        // No phone. This is the row the `user_has_identifier` CHECK exists for:
        // the email is the identifier, and the CHECK is what stops a row with
        // neither from being written now that `phone` is nullable.
        phone: null,
        email,
        passwordHash,
        role,
        displayName: input.displayName ?? null,
        // Class 10 by default, for the reason `verifyOtp()` gives: it is the
        // class with the board exam. Only a student gets a profile — an
        // evaluator row carrying a class number would be a lie, and the schema
        // deliberately has no column for it.
        ...(role === "STUDENT"
          ? { studentProfile: { create: { classNum: input.classNum ?? 10 } } }
          : {}),
        // A development evaluator with no profile cannot be routed a ticket,
        // which makes the account useless for the one thing it was created to
        // try. Subjects stay empty: those are a claim about qualifications and
        // an admin route's business, not a sign-up field.
        ...(role === "EVALUATOR"
          ? { evaluatorProfile: { create: { evaluatorType: "INTERNAL_TUTOR" } } }
          : {}),
      },
    });
    return { created: true };
  } catch (err) {
    if (isUniqueViolation(err, "email")) {
      // Taken. Say nothing, do nothing, and cost the caller the same as a
      // success did. See the note above.
      return { created: false };
    }
    throw err;
  }
}

export interface LoginInput {
  email: string;
  password: string;
  scopeId?: string;
}

/**
 * The one message a failed sign-in ever gives.
 *
 * Unknown address, address that exists but has only ever used OTP, and correct
 * address with the wrong password are three different facts and one response.
 * Distinguishing them is how a sign-in form becomes a way to check whether a
 * particular person has an account here, which docs/PLATFORM.md calls nobody's
 * business — and it is: a list of a school's students is a thing people buy.
 */
function loginFailed(): ApiError {
  return new ApiError("UNAUTHENTICATED", "That email and password do not match an account.");
}

/**
 * Check an email and password, and hand back the user. Minting the session is
 * the route's job, through `startSession()` — there is one definition of being
 * signed in and this is not a second one.
 */
export async function loginWithPassword(input: LoginInput): Promise<User> {
  const scopeId = input.scopeId ?? PUBLIC_SCOPE_ID;
  const email = normaliseEmail(input.email);
  if (!email) {
    // Malformed input, not a wrong guess. Saying so leaks nothing — it is a
    // fact about the string the caller typed, not about who has an account.
    throw ApiError.validation([{ path: "email", message: "is not a valid email address" }]);
  }
  if (input.password.length > PASSWORD_MAX_LENGTH) {
    throw ApiError.validation([
      { path: "password", message: `must be at most ${PASSWORD_MAX_LENGTH} characters` },
    ]);
  }

  const key = `${scopeId}:${email}`;
  consumeLogin(key);

  const user = await prisma.user.findUnique({ where: { scopeId_email: { scopeId, email } } });
  if (!user || !user.passwordHash) {
    // No user, or a user who has only ever signed in with a code. Same work,
    // same wording, same status — the two are indistinguishable from outside.
    await burnPasswordTime(input.password);
    throw loginFailed();
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    throw loginFailed();
  }

  clearLogin(key);
  return user;
}
