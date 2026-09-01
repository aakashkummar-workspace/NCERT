# Deploying

## What this deployment is for

**It is not a public launch.** [PERMISSIONS.md](./PERMISSIONS.md) records that hosting the
mirrored NCERT textbooks is republishing, that NCERT treats republishing without permission
as infringement, and that **the permission request has still not been sent**. Nothing below
changes that, and nothing below puts a textbook or a past-paper scan on a public URL. If
you find yourself editing `.vercelignore` to make the reader show chapters, stop and send
the email first.

What is being deployed is the **server half**, for one named person:

> `docs/teacher-review.md` asks a teacher to settle 342 marking decisions and photograph
> handwritten answers. Today the only way to reach the app is `localhost` on the owner's
> laptop. The teacher needs a URL they can open on their own phone, an account to sign in
> with, the CBSE marking schemes to read against, and a camera upload that works.

That is the target. Everything here is in service of it.

---

## 1. What to sign up for

Three accounts. All three have a free tier that is enough for one teacher.

| | what for | which one, and why |
| --- | --- | --- |
| **Vercel** | runs the app | The project is already a Next.js app on a Node runtime. Hobby is enough: nothing large is uploaded (see §5), and function regions are settable on Hobby, which matters because the teacher is in India. |
| **Managed Postgres** | the marks, the accounts, the queue | Neon, Supabase or Vercel Postgres. Any of them works; §3 explains the one thing they all get wrong if you are not careful. Neon's free tier is the least fuss. |
| **S3-compatible object storage** | answer-sheet photographs, voice notes, and the marking schemes | Cloudflare R2 has no egress charge and a 10 GB free tier. AWS S3, Backblaze B2 or anything else speaking the S3 API works identically — the code names no provider. |

There is deliberately **no SMS provider**. `deliverOtp()` throws in production, so the phone
sign-in cannot let anyone in. The teacher signs in with **email and password** through
`/signin`, which is exactly why that path exists.

---

## 2. One line in `package.json`

`@prisma/client` is generated, not shipped. Without this, the Vercel build fails at the
first module that imports it, with a message about a missing `.prisma/client`.

Add to `"scripts"`:

```json
"postinstall": "prisma generate"
```

That is the **only** change `package.json` needs. `prisma` is already a devDependency,
`tsx` is already there for the seed, and `"prisma": { "seed": "tsx prisma/seed.ts" }` is
already declared.

Two optional additions, if you want them wired into the existing runners rather than
remembered:

```json
"s3:check": "tsx scripts/test-s3.ts",
"schemes:publish": "tsx scripts/publish-schemes.ts"
```

Nothing depends on those; both scripts run fine as `npx tsx scripts/…`.

---

## 3. Environment variables

Set every one of these in **Vercel → Settings → Environment Variables**, for Production
(and Preview, if you use previews). They are needed at **build** time as well as at run
time: Next evaluates route modules during the build, and `new PrismaClient()` throws if
`DATABASE_URL` is absent.

### Required

| variable | where the value comes from |
| --- | --- |
| `DATABASE_URL` | The **pooled** connection string. Neon: the host containing `-pooler`. Supabase: *Connection pooling*, port **6543**. Vercel Postgres: the value it calls `POSTGRES_PRISMA_URL`. Every request opens a connection; the pooler is what stops that exhausting the database. |
| `DIRECT_URL` | The **direct** connection string for the same database — port **5432**, no pooler. Neon: the host *without* `-pooler`. Supabase: *Direct connection*. Used only by `prisma migrate deploy`. See §4 for why it is not optional. |
| `SESSION_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. At least 16 characters. Rotating it signs everybody out — the only revocation lever there is. |
| `STORAGE_DRIVER` | The literal string `s3`. Anything else means the local driver, which in production accepts uploads and hands back `/api/dev/storage/` links that 404 — a teacher photographing answers into a black hole. |
| `S3_ENDPOINT` | R2: `https://<account-id>.r2.cloudflarestorage.com` (Cloudflare dashboard → R2 → *Use the S3 API*). AWS: `https://s3.<region>.amazonaws.com`. Origin only — no bucket, no trailing slash. |
| `S3_BUCKET` | The bucket name. **Create it private.** Nothing here needs public read. |
| `S3_REGION` | R2: `auto`. AWS: the real region, e.g. `ap-south-1`. |
| `S3_ACCESS_KEY_ID` | R2: an API token with *Object Read & Write*, scoped to this bucket. AWS: an IAM user limited to `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `arn:aws:s3:::<bucket>/*`. |
| `S3_SECRET_ACCESS_KEY` | Shown once when the token is created. If you lose it, make a new token. |

### Recommended

| variable | value | why |
| --- | --- | --- |
| `NEXT_PUBLIC_PYQ_ARCHIVE` | `off` | The past-paper scans are not deployed. Without this the app generates routes into images that are not there. `/past-papers` then renders its empty state; nothing else is affected. |
| `OTP_SECRET` | another 32 random bytes | Falls back to `SESSION_SECRET`. Separating them means rotating one does not invalidate the other. |
| `STORAGE_URL_SECRET` | another 32 random bytes | Same reasoning. Only the local driver uses it, but the process refuses to start without one of the two in production. |

### Optional

| variable | default | effect |
| --- | --- | --- |
| `S3_SESSION_TOKEN` | unset | Only for temporary STS credentials. |
| `S3_FORCE_PATH_STYLE` | `true` | `https://host/bucket/key`. Set `false` only on AWS with a bucket that requires virtual-hosted addressing. |
| `ANTHROPIC_API_KEY` | unset | Machine grading. **Leave it unset for the teacher review.** Without it, `/api/grading` returns a notice and submissions stay queued and unmarked — which is the correct state until the rubrics are signed off. |
| `EVALUATOR_TIME_ZONE` | `Asia/Kolkata` | Queue shift windows. Already right. |
| `TICKET_LEASE_MINUTES` | see `src/lib/queue.ts` | How long a claimed ticket is held. |

---

## 4. Deploying, in order

### a. Database first

Create the database, then run the migrations from your laptop — **not** from the build.
Migrations are a deliberate act, and a build that migrates is a build that can roll a schema
forward on a deploy nobody meant to make.

```bash
# the production URLs, exported locally just for this command
export DATABASE_URL='<pooled>'
export DIRECT_URL='<direct>'

npx prisma migrate deploy      # applies prisma/migrations/ in order
npx prisma migrate status      # must say the database is up to date
```

`directUrl` on the datasource is what makes this work. Every managed Postgres here fronts
the database with PgBouncer in **transaction mode**, and migrations need session-level
state — an advisory lock to serialise concurrent deploys, and `CREATE TYPE` / `ALTER TABLE`
inside one session. Point `migrate deploy` at the pooled URL and it fails partway through
with a lock or prepared-statement error that names neither cause. (The same pooler has a
second, worse consequence for any future tenant scoping; `docs/PLATFORM.md` §6 spells it
out under *The landmine*.)

Seeding is optional and is fixtures, not production data:

```bash
npx tsx prisma/seed.ts         # safe to re-run
```

### b. Object storage

Create the bucket **private**, then prove the credentials actually work before trusting a
deployment to them:

```bash
export STORAGE_DRIVER=s3 S3_ENDPOINT=… S3_BUCKET=… S3_REGION=… \
       S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…
npx tsx scripts/test-s3.ts
```

44 checks: it puts real bytes, fetches them back through a pre-signed URL with no
credential attached, compares the SHA-256, confirms a tampered and an expired signature are
both refused, and deletes. Signing is hand-written SigV4 over `node:crypto` (no AWS SDK) —
see the header of `src/lib/s3.ts` — so this is not optional diligence.

### c. Vercel

Connect the Git repository (Settings → Git). **Prefer the Git integration to the CLI**:
a Git deploy contains only what is committed, and everything copyrighted here is
gitignored, so a Git deploy cannot leak a corpus even by accident. A CLI deploy uploads the
working directory — gitignored files included — and is safe only because `.vercelignore`
excludes them. Read that file before ever running `npx vercel`.

Then set the environment variables from §3 and deploy. Vercel runs `npm install`
(triggering `postinstall: prisma generate`) and then `npm run build`, which is
`node scripts/copy-pdf-worker.mjs && next build`.

`vercel.json` sets `regions: ["bom1"]` — Mumbai. The default is Washington DC, which puts
two ocean crossings between a teacher's phone and every database round trip. Remove it if
your database is not in Asia.

### d. The marking schemes

The 41 questions in Part A and B of `docs/teacher-review.md` are read against CBSE marking
schemes in `public/papers/` — 27 distinct PDFs, 18 MB. They are gitignored, so **the
deployment contains none of them**, and they must not be added: they are CBSE's copyright
and a public URL for them is the thing PERMISSIONS.md forbids.

They travel through the same private bucket as everything else:

```bash
# same S3_* exports as above
STORAGE_DRIVER=s3 npx tsx scripts/publish-schemes.ts --ttl-days 7
```

That uploads each scheme under a `schemes/` prefix and writes
`scripts/.tmp/teacher-schemes.md` — a list of pre-signed links to paste into one message to
one teacher. The links expire (seven days is the S3 maximum), the bucket grants the public
nothing, and `scripts/.tmp/` is gitignored, which matters because a committed signed URL
publishes the file it points at for as long as it lives.

Re-sign without re-uploading when they run out:

```bash
STORAGE_DRIVER=s3 npx tsx scripts/publish-schemes.ts --links-only
```

`--all` covers all 64 marking schemes rather than the 27 the queue cites.

### e. An account for the teacher

`/signin` → register with email and password. New accounts are `STUDENT` in production,
always; there is no role picker outside development. Promote by hand:

```bash
DATABASE_URL='<pooled>' npx tsx -e "
  import prisma from './src/lib/db';
  await prisma.user.update({ where: { email: 'teacher@example.com' }, data: { role: 'EVALUATOR' } });
"
```

---

## 5. What is deliberately not deployed

| | size | why not |
| --- | --- | --- |
| `public/ncert/` — 155 textbook PDFs | ~264 MB | © NCERT. Serving them is republishing, and the permission request in PERMISSIONS.md is **unsent**. Also two and a half times Vercel's Hobby upload cap. |
| `public/papers/` — CBSE sample papers and schemes | 78 MB | © CBSE. Reaches the teacher through expiring signed links instead (§4d). |
| `public/pyqs/` — past-paper page scans | ~1.3 GB, ~20,000 files | The archive permits personal download and forbids redistribution. Also breaks the 15,000-file limit of every Vercel plan on its own. |
| `public/exemplar/` | — | Same position as the textbooks. |
| `.storage/` | — | Local answer sheets and voice notes. Uploading them would be the worst mistake in this document. |
| `.env` | — | Vercel's default exclusions cover `.env.local` but **not** a plain `.env`. `.vercelignore` covers it explicitly. |

The consequence is a deployment where the reader's chapter pages resolve but the PDFs
404, and `/past-papers` shows its empty state. That is correct and intended: this
deployment is the marking half, not the reading half.

**`.vercelignore` protects the CLI path only.** Vercel's documentation is explicit that its
ignore rules "are only relevant when using Vercel CLI"; a Git-integration deploy clones the
repository and `.gitignore` decides what it contains. Both paths are now covered, but they
are covered by different files.

---

## 6. Verifying a deployment

```bash
BASE=https://<your-deployment>.vercel.app

# 1. It is up, and it is the server build, not a static export.
curl -sI "$BASE/" | head -1

# 2. The database is reachable and the session layer answers.
curl -s "$BASE/api/auth/session/" | head -c 200        # 401 with a JSON envelope

# 3. The dev-only routes are closed. Both must be 404, not 200.
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/dev/login/"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/dev/storage/?key=x&expires=1&signature=x"

# 4. Nothing copyrighted is public. All three must be 404.
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/ncert/jesc101.pdf"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/papers/class10-science-2025-26-ms.pdf"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/pyqs/"

# 5. The bucket is private. Strip the signature from any link in
#    scripts/.tmp/teacher-schemes.md and fetch it — 403, not 200.
```

Then the part no `curl` can check, done on a phone:

1. Open `$BASE` on the teacher's phone; add to home screen.
2. Register at `/signin`, sign in, sign out, sign in again — the session cookie survives.
3. Start a submission and photograph a page. It must appear in the list afterwards, and
   its thumbnail must load — that is the whole S3 round trip, from a phone camera.
4. Open one link from `teacher-schemes.md`. It must download a PDF.

If step 3 fails with a 413, see the next section.

---

## 7. Known limits, and the one that will bite

**Vercel caps a function request body at 4.5 MB.** `POST /api/submissions/{id}/pages/`
takes the photograph as `multipart/form-data` — deliberately, so that content type, size
and SHA-256 are measured server-side rather than claimed by the client (`docs/PLATFORM.md`
§4). But `STORAGE_POLICY.image.maxBytes` is 12 MB, and a modern phone camera routinely
produces 4–8 MB JPEGs. Those uploads will be rejected by Vercel's edge with a 413 before
the route ever sees them.

Three ways out, none of which this lane took, because each changes code it does not own:

1. **Downscale in the browser before uploading.** `src/components/AnswerCapture.tsx`
   already decodes each shot to a canvas for its glare and blur checks; re-encoding at
   ~2000 px on the long edge would put every realistic photograph under the cap and lose
   nothing a marker reads.
2. **Pre-signed `PUT` straight to the bucket.** The upload route's own header calls this
   "the right shape for S3", and it is now one function away — `src/lib/s3.ts` already
   signs; a `presignPut` alongside `presignGet` is a few lines. The cost is that the three
   pinned values must then be verified after the fact rather than measured during, which is
   a real change to the guarantee in §4 of the platform contract and needs a decision, not
   a patch.
3. **Host somewhere without the cap** — a container on Fly, Render or a VPS. Everything
   here except `vercel.json` and `.vercelignore` applies unchanged.

Until one of those happens, tell the teacher to set their camera to a lower resolution.

Other limits worth knowing:

- **Pre-signed URLs expire.** 15 minutes for answer-sheet reads, up to 7 days for the
  marking schemes. That is a feature; re-run `--links-only` rather than lengthening it.
- **No SMS.** Phone OTP sign-in throws in production by design. Email and password is the
  way in.
- **Machine grading is off** without `ANTHROPIC_API_KEY`, and should stay off until the
  rubrics are signed. Until then it may only be generous — see `docs/teacher-review.md`.

---

## 8. Taking it down

Deleting the Vercel project removes the app. Deleting the bucket removes every answer
sheet and every marking scheme in one action. Neither leaves a copy of an NCERT textbook
anywhere, because none was ever uploaded.

`/about` invites NCERT to request removal. The permission request in PERMISSIONS.md is
still the open action, and this deployment does not substitute for it.
