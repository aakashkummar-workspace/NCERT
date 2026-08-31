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
src/lib/auth.ts      the OTP flow — requestOtp, verifyOtp
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

Phone-first. A Class 9 student in India routinely has no email address, so `User.phone` is
the identifier and there are no passwords anywhere.

```
POST /api/auth/otp/request/   { phone }
    → { challenge, expiresInSec, devCode }     devCode is development-only
POST /api/auth/otp/verify/    { challenge, code, displayName?, classNum? }
    → sets the cookie, returns { user, isNewUser }
GET  /api/auth/session/       → { user, studentProfile, evaluatorProfile }  or 401
POST /api/auth/logout/        → clears the cookie
```

There is no SMS provider and this repo does not add one. In development the code is
**deterministic** — derived from the phone number — printed to the server log, and returned
as `devCode`. That is a development affordance and a production catastrophe, so
`devCodeFor()` throws outright when `NODE_ENV === "production"`, and `deliverOtp()` throws
rather than returning 200 for a message it did not send.

`POST /api/auth/otp/request/` answers identically for a number that has an account and one
that does not. "No account with that number" is an account-existence oracle, and whether a
given person uses this platform is nobody's business.

**A new account is always `STUDENT`.** `verifyOtp()` has no `role` parameter, and the
verify route's body validator has no `role` field. `EVALUATOR` and `ADMIN` are
provisioned — by the seed, or by an admin-only route — never claimed. If your lane needs to
grant a role, write a route behind `requireUser("ADMIN")`; do not add a field to sign-up.
A role accepted from a request body is a one-line path from anonymous to administrator,
and it gets added because the field looks like data rather than like a privilege.

### Signing in during development, without the dance

```bash
curl -sX POST localhost:3310/api/dev/login/ -H 'content-type: application/json' \
  -d '{"phone":"+919810000001"}' -c jar.txt
curl -s localhost:3310/api/auth/session/ -b jar.txt
```

`/api/dev/login/` signs you in as an existing seeded user with no code. It 404s when
`NODE_ENV === "production"` and creates nothing. `GET /api/dev/login/?phone=+91…` returns
the deterministic OTP if you would rather drive the real verify route.

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
pointing at `/api/dev/storage/`. `STORAGE_DRIVER=s3` is the production shape and is
**deliberately unimplemented** — every method throws. A storage driver that silently
succeeds while writing nowhere is discovered when a student asks where their marks went.

`.storage/` rather than `public/` on purpose: anything under `public/` is served by Next.js
with no check at all, which would make every answer sheet world-readable to anyone who can
guess a UUID.

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
| `+919810000031` | Vikram Desai | `ADMIN`, in the school scope |

The two evaluators have deliberately **disjoint** subjects, so a router that ignores
subject entirely still shows up as the wrong name on a ticket. Priya is off the queue
without being deleted — the case `activeForRouting` exists for, and the one a router forgets.

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

**OTP rate limiting is in-process and best-effort.** The counters in `src/lib/auth.ts` live
in memory: they reset on deploy and do not span instances. A 6-digit code with an unbounded
attempt budget falls in well under a million tries. Before this faces the internet it needs
a shared store, and `consumeAttempt()` is the one function that changes.

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
- Do not add a dependency without saying so. There is no `zod`, no `bcrypt`, no `jose`, no
  AWS SDK, and everything here works without them.
- Do not drop the trailing slash on an API path. §2.
