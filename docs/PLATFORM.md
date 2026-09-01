# The platform contract

Everything the NCERT reader does today happens in the browser. This document is about
the other half — the server that stores a photographed answer sheet, grades it, routes it
to a human, and hands back a mark somebody else awarded. `prisma/README.md` explains what
the *data* looks like and why. This explains how you reach it from a route.

Five feature lanes build on what is described here. If you are one of them, the four
things you need are [the session](#1-who-is-asking), [the route
wrapper](#2-writing-a-route), [the error shape](#3-when-things-go-wrong), and
[idempotency](#5-surviving-a-retry). The rest is context.

```
src/lib/api.ts       route wrapper, validation, error shape, idempotency helpers
src/lib/session.ts   getSession, requireUser, startSession, endSession
src/lib/auth.ts      both ways in — the OTP flow and email + password
src/lib/storage.ts   put / getSignedUrl / delete, over a local or S3 driver
src/lib/db.ts        the one Prisma client (pre-existing; do not construct another)
prisma/seed.ts       the fixtures you develop against
```

---

## 1. Who is asking

> **The acting user and their scope come from the session, and from nowhere else.**
>
> Not from a `studentId` in the body. Not from a `?userId=` in the query. Not from an
> `X-User-Id` header your job runner sets. This is a rule, not a guideline, and there is
> no route in this codebase that is an exception to it.

The specification this platform replaces got this wrong: its endpoints took the student's
id as a request parameter and trusted it. That is not a validation gap that stricter
checking downstream repairs — it means any signed-in student can read, grade, and delete
any other student's work by changing one number in a URL, and it means the audit trail on
an append-only grading table records whoever the attacker said they were. There is no
recovery from that after the fact, which is why it is the first section here.

The wrapper is built so the correct thing is the only thing on offer. `route()` hands your
handler a `user` it fetched itself; there is no parameter that overrides it.

```ts
export const POST = route({ auth: "STUDENT" }, async ({ user, scopeId }) => {
  // user is a full Prisma `User` row, read fresh from the database this request.
  // scopeId is user.scopeId. Filter every query by one or both.
  return prisma.submission.findMany({ where: { studentId: user.id } });
});
```

**Scope is subject to the same rule.** `scopeId` is the seam tenancy retrofits through
(see `prisma/README.md`), and today every B2C row sits on the nil UUID. An admin is an
admin *of a scope*, not of the platform. When you write an admin query, filter by
`user.scopeId` even though it is the nil UUID for everyone right now — the day it is not,
the query that forgot is the one that shows one school another school's marks.

### The two accessors

| | reads the DB | use it when |
| --- | --- | --- |
| `getSession()` | no | you only need `userId`, for logging or a filter you were writing anyway |
| `requireUser(role?)` | yes | anything else, and always when a **role** decides what happens |

```ts
import { getSession, requireUser } from "@/lib/session";

const session = await getSession();          // Session | null — cookie claims only
const { user } = await requireUser();        // any signed-in user, or throws 401
const { user } = await requireUser("ADMIN"); // or throws 403
const { user } = await requireUser(["EVALUATOR", "ADMIN"]);
```

`requireUser()` re-reads the `users` row every call, deliberately. The cookie is good for
30 days and states whatever was true when it was issued: it will happily claim `ADMIN` for
someone demoted since, and claim a user id that has been deleted. A role you authorise on
must be true now, and one indexed primary-key lookup is a cheap price for that.

Both throw `ApiError`, so inside a `route()` handler you never catch them — the wrapper
turns them into a 401 or a 403.

### What a session is

A signed cookie, not a row. There is no `sessions` table: `prisma/schema.prisma` is final
and scoped to Phases 0–4. The cookie holds `{ uid, sid, role, iat, exp }` and an
HMAC-SHA256 of that under `SESSION_SECRET`. It is `HttpOnly`, `SameSite=Lax`, `Secure`
outside development, and lives 30 days.

**The cost, stated plainly because you will eventually hit it: an issued session cannot be
revoked individually.** Signing out clears the cookie, which handles the person at the
keyboard but not a stolen one. Rotating `SESSION_SECRET` invalidates every session at
once and is the only other lever. If "sign out of all devices" is ever a requirement, the
fix is a `sessions` table plus a `sid` claim, and `getSession()` is the one function that
changes.

### Signing in

Two ways in. Both end at the same cookie, minted by the same `startSession()`.

```
POST /api/auth/register/      { email, password, displayName?, classNum? }
    → 201 { ok: true }, always, and never a session. See below.
POST /api/auth/login/         { email, password }
    → sets the cookie, returns { user, expiresAt }

POST /api/auth/otp/request/   { phone }
    → { challenge, expiresInSec, devCode }     devCode is development-only
POST /api/auth/otp/verify/    { challenge, code, displayName?, classNum? }
    → sets the cookie, returns { user, isNewUser }

GET  /api/auth/session/       → { user, studentProfile, evaluatorProfile }  or 401
POST /api/auth/logout/        → clears the cookie
```

The screen for both is `/signin/`, which is `src/components/SignInForm.tsx`.

#### Why there are two

Phone-first was the right call and still is: a Class 9 student in India routinely has no
email address, and a one-time code to the number the account *is* beats a password to
forget, to reset, and to reuse.

But **there is no SMS provider**. `deliverOtp()` throws in production rather than returning
200 for a message it did not send, which means that on a real deployment the phone flow
cannot let anybody in at all. An identity system nobody can use is not a safer identity
system. Email and password were added **alongside** the OTP flow, not instead of it: the
OTP path is unchanged, and an account created by it is untouched by any of this.

In development the OTP code is still **deterministic** — derived from the phone number,
printed to the server log, and returned as `devCode`. That is a development affordance and
a production catastrophe, so `devCodeFor()` throws outright when
`NODE_ENV === "production"`.

`phone`, `email` and `passwordHash` are consequently all nullable, and a user may hold any
subset of them provided they hold at least one identifier. That last clause is a CHECK
constraint, not a convention — §6.

#### Passwords

`scrypt` from `node:crypto`, and no new dependency: no bcrypt, no argon2, no jose. A random
per-user salt, a `timingSafeEqual` comparison, and a stored value that describes itself —

```
scrypt$16384$8$1$64$<salt base64url>$<hash base64url>
```

— so the cost parameters can be raised later without anyone having to guess what an
existing row was hashed with. `verifyPassword()` reads N, r, p and the key length out of
the string it was handed and never assumes the current ones. Ten characters minimum, a
short refusal list, and no strength meter: a meter teaches people to append `1!`.

#### Neither endpoint says whether an address exists

`POST /api/auth/otp/request/` answers identically for a number that has an account and one
that does not: "no account with that number" is an account-existence oracle, and whether a
given person uses this platform is nobody's business. Registration and login must not
reopen from the email side what that closed.

- **Registration always returns `201 {"ok":true}`.** A taken address is not an error, not a
  409, and not a different latency — the password is hashed before anything is written and
  the unique violation is swallowed, so both paths do the same work and return the same
  bytes.
- **Which is why registration cannot sign you in.** If the address already existed, the
  session it minted would belong to somebody else. The client registers and then calls
  login; that is one more round trip and no more steps for the person typing.
- **Every login failure is one 401 with one message.** An unknown address, an address that
  has only ever used a code, and the right address with a wrong password are three
  different facts and one response. The no-user path verifies against a throwaway hash so
  that it costs the same ~100 ms a real one does; identical wording with a one-millisecond
  reply is still an oracle.
- **Attempts are rate-limited per identifier**, counted on failures against addresses that
  do not exist as well. A limiter that skips unknown addresses is itself an oracle — the
  attacker learns which ones exist by watching which can be hammered forever. It is the
  same in-process counter OTP sending uses, with the same caveat: §7.

#### The role is never claimed

**A new account is always `STUDENT`.** `verifyOtp()` has no `role` parameter; neither the
verify route's body validator nor, in production, the register route's has a `role` field.
`EVALUATOR` and `ADMIN` are provisioned — by the seed, or by an admin-only route — never
claimed. If your lane needs to grant a role, write a route behind `requireUser("ADMIN")`;
do not add a field to sign-up. A role accepted from a request body is a one-line path from
anonymous to administrator, and it gets added because the field looks like data rather than
like a privilege.

Outside production `POST /api/auth/register/` does accept a `role`, so that one person can
hold a student, an evaluator, a parent and an admin account without four admin-only routes
existing first. It is gated the way `/api/dev/login/` gates itself — twice, independently:

1. `bodyValidator()` in the route builds a shape with **no `role` key at all** when
   `NODE_ENV === "production"`. `v.object` reads only the keys it declares, so a posted
   `{"role":"ADMIN"}` is never parsed and there is no value to pass on.
2. `registerWithPassword()` re-checks `isProduction()` itself and pins `STUDENT` before it
   looks at the field, so reaching the function directly does not get past it either.

Either would be sufficient. There is no environment variable that turns this on; there is
only `NODE_ENV`, which turns it off.

#### Scope

Sign-in is always the **public scope**. `scopeId` is not accepted by any of these routes,
for the reason §1 gives about tenants: letting a caller name their own tenant is the same
class of hole as letting them name their own user. School-branded sign-in, when it lands,
resolves the scope from the hostname or an invite token, server-side.

A consequence worth knowing before you go looking for it: a seeded user in another scope —
Vikram, the school admin — cannot sign in at `/signin/` even with the right password. He is
reachable through `/api/dev/login/`, which does take a `scopeId` and 404s in production.
### Signing in during development, without the dance

```bash
curl -sX POST localhost:3310/api/dev/login/ -H 'content-type: application/json' \
  -d '{"phone":"+919810000001"}' -c jar.txt
curl -s localhost:3310/api/auth/session/ -b jar.txt
```

`/api/dev/login/` signs you in as an existing seeded user with no code. It 404s when
`NODE_ENV === "production"` and creates nothing. `GET /api/dev/login/?phone=+91…` returns
the deterministic OTP if you would rather drive the real verify route.

Every seeded user also has an email and the password **`ncert-dev-2026`**, printed at the
end of a seed run, so `/signin/` is usable without a terminal at all. `seedPasswords()`
refuses when `NODE_ENV === "production"` — a known password on every account is not a
smaller hole than a known one-time code.

---

## 2. Writing a route

```ts
// src/app/api/submissions/route.ts
import { route, v, createOnce } from "@/lib/api";
import prisma from "@/lib/db";

export const POST = route(
  {
    auth: "STUDENT",
    idempotent: true,
    body: v.object({
      paperSlug: v.optional(v.string({ max: 120 })),
      subject: v.string({ max: 60 }),
      classNum: v.int({ min: 9, max: 10 }),
      pageCount: v.int({ min: 1, max: 40 }),
    }),
  },
  async ({ user, body, idempotencyKey }) => {
    const { row, created } = await createOnce({
      constraint: "idempotencyKey",
      create: () =>
        prisma.submission.create({
          data: { studentId: user.id, idempotencyKey, ...body },
        }),
      find: () =>
        prisma.submission.findUnique({
          where: { studentId_idempotencyKey: { studentId: user.id, idempotencyKey } },
        }),
    });
    return { submissionId: row.id, created };
  },
);
```

### The spec

| key | meaning |
| --- | --- |
| `auth` | `"any"`, a `UserRole`, or an array of them. **Omitting it makes the route public** — a decision you make in writing, because there is no default that quietly lets everyone in. |
| `body` | a validator. Declare one and `ctx.body` is parsed and typed; omit it and there is no `ctx.body` to read. |
| `idempotent` | demand an `Idempotency-Key` header and expose it as `ctx.idempotencyKey`. See §5. |

### The context

`{ req, body, user, scopeId, session, idempotencyKey, params, requestId }`. `params` is
already awaited. Return a plain value and it is serialised as `200 {json}`; return a
`NextResponse` and it passes through untouched, which is how you set a 201 or a cookie.

### Note the trailing slashes

`next.config.ts` sets `trailingSlash: true`, and it must stay true — the service worker
keys its shell cache on the `/path/` form. That applies to route handlers too:
`POST /api/auth/session` 308-redirects to `/api/auth/session/`, and **a 308 on a POST that
your client does not follow with the body intact will look like a mysterious empty
request**. Write the trailing slash. `curl` needs `-L --post301 --post302 --post303` to
follow one, which is easier to just avoid.

### Validation

There is no `zod` here and this lane did not add one — 60 kB of runtime to express "an
object with a phone and a six-digit code" is not a trade worth making at eleven call
sites. `v` in `src/lib/api.ts` covers what routes need and narrows types the same way:

```ts
v.string({ min, max, pattern, trim })   v.int({ min, max })    v.number({ min, max })
v.boolean()   v.date()   v.uuid()   v.phone()
v.enumOf(["MCQ", "SA", "LA"] as const)
v.array(item, { min, max })   v.object({ … })
v.optional(inner)   v.withDefault(inner, fallback)
```

Validators collect **every** problem rather than throwing on the first, so a student on a
two-second connection gets all four mistakes in one round trip. Outside a route, use
`parseOrThrow(validator, value)`.

`v.phone()` normalises to E.164 as it validates. Indian numbers arrive as `9876543210`,
`09876543210`, `+91 98765 43210`, `91-9876543210` and `+919876543210`, and every one is the
same person. Normalising at the edge is what makes `@@unique([scopeId, phone])` mean
anything — the schema says the database will not do it for you, and two spellings of one
phone are two accounts.

If you need a shape `v` cannot express, add a combinator to `src/lib/api.ts` rather than
hand-rolling a check in your route.

---

## 3. When things go wrong

Throw `ApiError` from anywhere — including deep inside a helper — and the wrapper turns it
into this, always:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "classNum: must be at least 9",
    "issues": [{ "path": "classNum", "message": "must be at least 9" }],
    "requestId": "0f3c…"
  }
}
```

```ts
throw new ApiError("CONFLICT", "That ticket is already claimed.");
throw ApiError.notFound("Submission");
throw ApiError.forbidden();
throw ApiError.validation([{ path: "pageIndex", message: "is already used" }]);
```

| code | status | |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | carries `issues` |
| `UNAUTHENTICATED` | 401 | not signed in, or a stale cookie |
| `FORBIDDEN` | 403 | signed in, not allowed |
| `NOT_FOUND` | 404 | |
| `CONFLICT` | 409 | |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | the header was missing |
| `IDEMPOTENCY_KEY_REUSED` | 409 | same key, different request |
| `RATE_LIMITED` | 429 | |
| `PAYLOAD_TOO_LARGE` | 413 | |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | |
| `NOT_AVAILABLE` | 503 | a driver or provider is not configured |
| `INTERNAL` | 500 | a bug |

Treat these codes as a published interface. A phone in a village on 2G is running last
month's bundle and branching on the old meaning of a code you redefined.

**Anything that is not an `ApiError` becomes a bare 500 with no detail**, logged whole
server-side against the `requestId`. That is not defensiveness about tidy output: a raw
exception message can carry a column name, a query, or a connection string, and none of
those are the caller's business. `requestId` is echoed from `x-request-id` when the caller
sends one, generated when they do not, and returned as a response header — it is what turns
"it said something went wrong" into something greppable.

Your 403s should not distinguish "not yours" from "does not exist". A 403 that does is a
membership oracle: it tells a stranger which submission ids are real.

---

## 4. Files

The schema stores `storageKey` — an **object key, never a URL**. Pre-signed URLs expire, so
a stored one is a dead link by the next day. `src/lib/storage.ts` is the only thing that
turns a key into something fetchable, and it does that at read time, every time.

```ts
import storage, { storageKeys, extensionFor } from "@/lib/storage";

const bytes = Buffer.from(await file.arrayBuffer());
const object = await storage.put({
  key: storageKeys.submissionPage(submission.id, pageIndex, extensionFor(contentType)),
  body: bytes,
  contentType,               // checked against an allowlist this module owns
  storageClass: "image",     // "image" | "audio" | "document"
});

await prisma.submissionPage.create({
  data: {
    submissionId: submission.id,
    pageIndex,
    storageKey: object.key,        // the key, on the row
    contentType: object.contentType,
    bytes: object.bytes,           // measured, not claimed
    sha256: object.sha256,         // computed here
  },
});

const url = await storage.getSignedUrl(page.storageKey);   // 15 min. Never store it.
await storage.delete(page.storageKey);
```

**Content type and size are pinned server-side, and you cannot pass them in.** The
content type must be in `STORAGE_POLICY[storageClass].contentTypes`; a client-declared
`image/jpeg` on a file that is actually HTML is a stored-XSS delivery mechanism the moment
anything serves it back with that type. Size is measured from the buffer, not read from
`Content-Length`, because a client that lies about its length lies for a reason. `sha256`
is computed here so the column records what was stored rather than what we were told.

Limits: images 12 MB, audio 8 MB, PDF 25 MB. Voice notes are additionally capped at 90
seconds by a `CHECK` constraint in the database — see §6.

Use `storageKeys.*` rather than building a key by hand. The prefix is what a lifecycle
rule, a bulk delete, or an access policy is written against, and a prefix invented at three
call sites is three prefixes.

### Two drivers

`STORAGE_DRIVER=local` (the default) writes under a gitignored `.storage/` and signs URLs
pointing at `/api/dev/storage/`. `STORAGE_DRIVER=s3` talks to any S3-compatible object
store — R2, AWS S3, Backblaze, MinIO — addressed by `S3_ENDPOINT`, `S3_BUCKET`,
`S3_REGION` and a key pair. No provider is named anywhere in the code.

`.storage/` rather than `public/` on purpose: anything under `public/` is served by Next.js
with no check at all, which would make every answer sheet world-readable to anyone who can
guess a UUID.

**Production must be `s3`.** `/api/dev/storage/` returns 404 when `NODE_ENV=production`,
so a deployed `local` driver accepts uploads and then hands back links that do not
resolve. The default is `local` because a missing variable should fail in development,
where it is noticed; the deploy checklist in `DEPLOY.md` is where it stops being a default.

**Signing is hand-written.** `src/lib/s3.ts` implements SigV4 over `node:crypto` rather
than pulling in `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, for the same
reason `scrypt` and the session HMAC are not libraries either. The cost of that choice is
that a signing bug looks like `SignatureDoesNotMatch`, or worse like an upload that appears
to work, so it is paid for by `scripts/test-s3.ts` — 44 checks that round-trip real bytes
through a real S3 server:

```bash
docker run -d --name ncert-minio -p 9010:9000   -e MINIO_ROOT_USER=ncertminio -e MINIO_ROOT_PASSWORD=ncertminio123   minio/minio:latest server /data
docker exec ncert-minio mkdir -p /data/ncert-test

S3_ENDPOINT=http://127.0.0.1:9010 S3_BUCKET=ncert-test S3_REGION=us-east-1 S3_ACCESS_KEY_ID=ncertminio S3_SECRET_ACCESS_KEY=ncertminio123   npx tsx scripts/test-s3.ts

docker rm -f ncert-minio
```

Run it against any endpoint before trusting that endpoint. With no `S3_ENDPOINT` set it
checks the signing primitives only and says so.

The S3 driver pins exactly what the local one does. The content type sent is the
allowlisted one; the length is the buffer's; and the SHA-256 that goes on the row is also
sent as `x-amz-content-sha256` and covered by the signature, so the store rejects the
request outright if the bytes on the wire are not the bytes we hashed. The pre-signed GET
carries `response-content-disposition=attachment` **inside the signature**, which keeps the
"a mislabelled object downloads, it does not render" guarantee now that the bytes are
served from an origin we do not control.

### A signed URL is not authorisation

`/api/dev/storage/` checks the signature *and then* checks the session. A valid signature
proves only that we minted the link and it has not expired. Links get forwarded,
screenshotted, and pasted into class group chats. The route asks separately whether the
cookie-holder has business seeing the object: a student may read their own; an evaluator
may read a submission they have claimed, been assigned, or already reviewed — not any
submission, because an evaluator who can read everything by URL has no queue; an admin may
read anything **inside their own scope**. An object whose owner cannot be established is
served to nobody.

If your lane hands out a URL, apply the same check before you do.

---

## 5. Surviving a retry

Indian mobile networks drop and retry POSTs freely. A student who ends up with two copies
of one answer sheet is charged twice and shown two contradictory grades. **Every mutation
that costs money, creates a ticket, or writes a row a duplicate of which a student would
see must be idempotent.**

Set `idempotent: true` and the wrapper demands an `Idempotency-Key` header (≤ 64 chars,
generated by the client, one per logical action, reused on every retry).

Then let the database decide. Checking "does it exist?" before inserting does **not** work:
two retries arriving 30 ms apart both read nothing and both insert. So insert, and catch
the unique violation. `@@unique([studentId, idempotencyKey])` on `Submission` and
`submissionId @unique` on `EvaluationTicket` exist for exactly this.

```ts
const { row, created } = await createOnce({
  constraint: "idempotencyKey",          // fragment of the unique index name
  create: () => prisma.submission.create({ data: { studentId: user.id, idempotencyKey, … } }),
  find:   () => prisma.submission.findUnique({
    where: { studentId_idempotencyKey: { studentId: user.id, idempotencyKey } },
  }),
});
```

`find` **must be scoped to the acting user**, the way the unique itself is. A `find` that
looks the key up globally hands one student another student's row whenever two of them
generate the same key — which is not hypothetical, because clients generate keys and some
client will use a counter.

Use `createOnceStrict` when the request body carries something the row records — a page
count, an amount — and answering "yes, done" to a *different* body would silently discard a
real request:

```ts
await createOnceStrict({
  create, find, constraint: "idempotencyKey",
  matches: (existing) => existing.pageCount === body.pageCount,
});   // → 409 IDEMPOTENCY_KEY_REUSED when it does not match
```

`isUniqueViolation(err, "idempotencyKey")` is the raw predicate if you need it. Pass the
fragment: Prisma reports the *index* name on Postgres
(`submissions_studentId_idempotencyKey_key`), and matching on nothing catches unrelated
collisions and returns the wrong row.

### When the key is the row itself

Some mutations carry their own natural key and need no header. `POST /api/attempts/` syncs
a sitting the device has already named — `Attempt.clientAttemptId` is Dexie's own primary
key — and `@@unique([studentId, clientAttemptId])` makes the retry an update rather than a
second exam. That is a *stronger* guarantee than an `Idempotency-Key`: the key is the
sitting, not a random number a client has to remember across a reinstall. Demand the header
where the client has to invent the identity; use the natural unique where it already has
one. Either way the database decides, never a read-then-write.

Both exam flows land there. A dual-track sitting (`src/lib/test-attempts.ts`) is pushed and
then polled for a teacher’s mark; a self-marked practice paper (`src/lib/attempts.ts`) is
pushed and never polled, because it has no written handoff for anybody to mark. They share
one route because they are the same fact — this student sat this paper, these are the marks
— and everything downstream (`Answer.attemptQuestionId`, the parent’s subject trend,
`GET /api/attempts/`) is written against `Attempt` + `AttemptQuestion`. `src/lib/handoff-sync.ts`
is the only module that knows both halves.

### Claiming a ticket is not this

Claiming is a single conditional `UPDATE` against `evaluation_tickets` — `status`,
`claimedAt`, `claimedById` and `leaseExpiresAt` in one statement, with the status in the
`WHERE`. No Redis, no lock service, and no `createOnce`. The exact SQL is in
`prisma/README.md`; the indexes are ordered for it.

---

## 6. The database

```bash
docker run -d --name ncert-pg \
  -e POSTGRES_USER=ncert -e POSTGRES_PASSWORD=ncert -e POSTGRES_DB=ncert \
  -p 5433:5432 postgres:16
```

**Port 5433, not 5432.** Inside the container it is still 5432; only the host mapping
moved, because 5432 on this machine belongs to an unrelated project. `.env` and
`.env.example` both say 5433.

### Two URLs in production, and why

The datasource takes `url = env("DATABASE_URL")` **and** `directUrl = env("DIRECT_URL")`.
Locally they are the same string. In production they are not:

| | what it is | who uses it |
| --- | --- | --- |
| `DATABASE_URL` | the **pooled** URL — Neon's `-pooler` host, Supabase's port 6543, Vercel Postgres' `POSTGRES_PRISMA_URL` | the app, every request |
| `DIRECT_URL` | the **direct** URL, port 5432, no pooler | `prisma migrate deploy`, introspection |

Both are required. Prisma refuses to load a schema whose `env()` is unset, so a missing
`DIRECT_URL` fails `prisma generate` — and therefore the build — before it fails anything
subtler. Migrations need session-level state that a transaction-mode pooler does not keep:
an advisory lock to serialise concurrent deploys, and `CREATE TYPE` / `ALTER TABLE` inside
one session. Point `migrate deploy` at the pooled URL and it fails partway through with a
lock or prepared-statement error that names neither cause.

> ### The landmine: `SET` leaks through a transaction pooler
>
> Every managed Postgres this deploys on — Neon, Supabase, Vercel Postgres — is PgBouncer
> in **transaction mode**. A connection is handed to one transaction and then given to
> somebody else's. A session-level `SET` therefore outlives the request that issued it and
> is still in effect for whoever gets that connection next.
>
> This matters the day tenancy lands. `prisma/README.md` already notes that the
> specification's RLS policy compares a UUID to `current_setting(...)`, which returns
> `text`. The pooling half is the part that bites harder: the obvious implementation
>
> ```sql
> SET app.current_tenant_id = '…';   -- WRONG behind a transaction pooler
> ```
>
> does not scope anything. It sets a variable on a pooled connection, the request ends, and
> the next tenant's query runs under the previous tenant's setting — an RLS policy that
> reads perfectly and isolates nothing.
>
> The correct form is the transaction-local one, inside the same transaction as the queries
> it governs:
>
> ```ts
> await prisma.$transaction(async (tx) => {
>   //                                          ↓ true = local to this transaction
>   await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${scopeId}::text, true)`;
>   return tx.user.findMany();
> });
> ```
>
> `set_config(..., true)` is reset when the transaction ends, which is exactly when the
> pooler may hand the connection on. Anything outside a transaction, or with `false`,
> is a cross-tenant read waiting for load.

```bash
cp .env.example .env                # then fill DATABASE_URL
npx prisma migrate dev              # apply migrations
npx prisma generate                 # after any schema change
npx tsx prisma/seed.ts              # fixtures — safe to re-run
npx prisma migrate status
docker exec ncert-pg psql -U ncert -d ncert -c '\dt'
```

`src/lib/db.ts` will not typecheck until `prisma generate` has run once. That failure is
expected on a fresh clone.

Import `prisma` from `@/lib/db`. Do not construct a `PrismaClient`: it caches on
`globalThis` precisely so that hot reload does not open a new connection pool per save.
It is server-only — importing it from a `"use client"` file fails the build, which is the
correct failure.

### The CHECK constraints

`prisma/migrations/20260831100300_check_constraints/` holds the invariants Prisma's schema
language cannot express — the ones `prisma/README.md` documents. They are in their own
migration rather than hand-edited into `init`, so `init` stays exactly what
`prisma migrate dev` generates and can be regenerated without losing them.

Two things there differ from the SQL as printed in `prisma/README.md`, and if you add a
constraint you will hit both:

1. **Columns are quoted camelCase**, not snake_case. The models carry `@@map` for table
   names but no `@map` on any field, so Prisma emitted the field names verbatim:
   `"durationMs"`, not `duration_ms`. The README's SQL predates the generated migration
   and will not run as printed.
2. **Enum members compare as their mapped value where a `@map` exists** (`'step'`,
   `'choose'`, `'mcq'`) and as their Prisma name where none does (`'AI'`, `'UNMARKED'`,
   `'PENDING'`). Getting this backwards is not an error — it is a constraint that quietly
   never fires.

`prisma/migrations/20260831133652_email_password_signin/` adds one more, and it is the one
worth reading if you touch the `users` table:

- `user_has_identifier` — a user must have a phone, an email, or both. This is what
  replaced `NOT NULL` on `phone` when email sign-in landed, and it is not decoration.
  **NULLs are distinct in a Postgres unique index**, so `@@unique([scopeId, phone])`
  constrains nothing at all once the column is nullable: without the CHECK the database
  would accept any number of users in one scope with no phone, no email and nothing to tell
  them apart. Empty strings are excluded explicitly, because `''` is not NULL and would
  otherwise satisfy the CHECK while identifying nobody.

The ones you are most likely to trip over while writing grading code:

- `grade_source_consistent` — an `AI` grade has `evaluatorId` NULL; a `HUMAN` grade must
  have one.
- `criterion_verdict_consistent` — `UNMARKED` awards 0 and **must** carry an
  `unmarkedReason`; `MISS` awards 0 and must not; `PARTIAL` awards > 0; only `PARTIAL`
  names a `partialRuleId`.
- `criterion_marks_by_kind` — exactly one of `marks` / `marksEach` per kind, and an
  `OPTION` has neither.
- `diagram_not_auto_gradable` — a `DIAGRAM` criterion cannot claim `autoGradable`.
- `highlight_box_normalised` — boxes are fractions of the page in `[0, 1]`, not pixels.
- `class_supported` — `classNum` is 9 or 10. This will need relaxing the day Class 11
  ships, which is the point: it fails loudly at insert rather than quietly filling
  `/progress` with a class the app has no books for.

### The fixtures

`prisma/seed.ts`. Every id is derived from a stable name, so the same person has the same
UUID in your checkout and in mine — a hardcoded id in a smoke test stays true across
reseeds. It upserts and never truncates: another lane has real work in this database.

| phone | who | |
| --- | --- | --- |
| `+919810000001` | Aarti Sharma | Class 10 student, **`hitlEnabled`** — the one routed to a human |
| `+919810000002` | Imran Qureshi | Class 10 student |
| `+919810000003` | Devika Nair | Class 9 student |
| `+919810000004` | Rohit Yadav | Class 9 student, `language: "hi"` |
| `+919810000010` | Kabir / Ananya Menon | **siblings sharing one number in two scopes** |
| `+919810000021` | Meera Iyer | evaluator, `SCHOOL_TEACHER`, Science 9 + 10 |
| `+919810000022` | Sandeep Rao | evaluator, `FREELANCE`, Mathematics 10 + Social Science 10 |
| `+919810000023` | Priya Balan | evaluator, **`activeForRouting: false`** |
| `+919810000030` | Nisha Verma | `ADMIN`, in the public scope — the one who can route a seeded student |
| `+919810000031` | Vikram Desai | `ADMIN`, in the school scope |

Every one of them also has an `@example.invalid` email address and the password
`ncert-dev-2026`, so `/signin/` works out of the box; the seed prints them. Passwords are
skipped entirely when `NODE_ENV === "production"`.

The two evaluators have deliberately **disjoint** subjects, so a router that ignores
subject entirely still shows up as the wrong name on a ticket. Priya is off the queue
without being deleted — the case `activeForRouting` exists for, and the one a router forgets.

There are **two admins, in two scopes**, and the pair is the point. Every admin-only route
filters by `user.scopeId`, so Vikram — a school-scope admin — cannot route, dispatch or
read anything belonging to a public-scope student, and every seeded student is public-scope.
For a while he was the only seeded admin, which made `POST /api/tickets/dispatch/`
unreachable for every fixture on the platform: nobody could send a seeded student's script
to a human. Nisha is the public-scope admin that fixes it; Vikram stays as the fixture that
proves the boundary still holds.

There is no parent, because there is no `PARENT` in `UserRole` and `prisma/README.md`
scopes parent links out of Phases 0–4. Rather than fabricate one under a role that means
something else, the seed does the honest version: the Menon siblings share their parent's
number across two scopes, which is precisely the case `@@unique([scopeId, phone])` exists
to permit and a global unique on phone would have broken. When a parent role lands, that
shared number is the join.

Rubrics come from `data/rubrics.json` — 22 of 23 load. See the next section for the one
that does not.

---

## 7. Known gaps

Things a lane will hit. None is a mistake to work around silently.

**`kind: "alternatives"` has no home in the schema.** `data/rubrics.schema.md` defines a
fourth step kind for CBSE's "answer either printed alternative", with nested branches each
carrying their own `steps[]`. `CriterionKind` has `STEP`, `CHOOSE`, `DIAGRAM`, `OPTION` and
no member for it, and there is no column for the branches. The seed **skips**
`class10-science-2025-26-q28` rather than loading it lossily: a rubric whose steps do not
sum to its `maxMarks` grades every attempt at that question out of the wrong denominator,
which `prisma/README.md` itself calls the contract's most damaging error. Fixing it needs a
schema change — an `ALTERNATIVES` kind, a `BRANCH` kind, and a nullable `branchLabel`.

**Option ids are scoped per group in the contract and per rubric in the schema.**
`check-rubrics.mjs` starts a fresh `seenOptionIds` for each `choose` group, so two groups
in one rubric may both number their options `o1, o2, o3` — and
`class10-social-science-2025-26-q28` does. `RubricCriterion` has
`@@unique([rubricId, stepId])`. The seed stores an option's `stepId` **qualified with its
group**, as `g3/o1`, always rather than only on collision, so the id stays stable across
re-imports. That departs from the schema comment's claim that `stepId` is "the authored
step id … 's1', 'g1', 'o1'". Anything joining a `CriterionResult` back to authored JSON
must split on the `/`.

**Rate limiting is in-process and best-effort.** The counters in `src/lib/auth.ts` live in
memory: they reset on deploy and do not span instances. That covers OTP sends, OTP attempts
and password sign-ins alike. A 6-digit code with an unbounded attempt budget falls in well
under a million tries, and a password behind a limiter that forgets on every deploy is not
much better. Before this faces the internet it needs a shared store; `consumeAttempt()` and
`consumeWindowed()` are the two functions that change.

**There is no password reset, and no email delivery to build one on.** The same missing
provider that made the OTP flow unusable in production applies to email: nothing here sends
a message. A forgotten password today is an admin fixing a row. Whoever wires up a mail
provider gets reset tokens for nearly free — the challenge-token shape in `src/lib/auth.ts`
is already the right one, signed and expiring and carrying no row.

**Sessions cannot be revoked individually.** See §1.

**The S3 driver throws.** See §4.

---

## 8. Things not to do

- Do not read a user or a tenant out of a request body, query parameter, or header. §1.
- Do not construct a `PrismaClient`. Import `prisma` from `@/lib/db`.
- Do not store a signed URL. Store the `storageKey` and sign at read time. §4.
- Do not put uploads under `public/`. Nothing there is access-checked.
- Do not accept `role`, `scopeId`, or `hitlEnabled` from a sign-up or profile body.
- Do not read-then-insert for anything a retry could duplicate. §5.
- Do not `UPDATE` a `GradingResult`. Grading is append-only — an override is a new row with
  `revision + 1` and `supersedesId` pointing at what it replaced. `prisma/README.md`.
- Do not add a dependency without saying so. There is no `zod`, no `bcrypt`, no `argon2`, no
  `jose`, no AWS SDK, and everything here works without them — passwords are `scrypt` out of
  `node:crypto`.
- Do not let an auth route reveal whether an address or a number is registered. Same
  response, same status, same work. §1.
- Do not drop the trailing slash on an API path. §2.
