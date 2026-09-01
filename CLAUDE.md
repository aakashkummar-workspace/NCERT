# NCERT Quick — working notes

Two products in one repo, and the seam between them is the thing to understand first.

1. **An offline-first PWA reader** for NCERT Class 9 & 10 textbooks. Works with no
   network, no account, no server. This half is real, finished and useful.
2. **A CBSE grading platform** — a student photographs a handwritten answer, it is
   marked against the official marking scheme, a human can override, a parent sees a
   trend. Built, connected and tested. **It has never actually graded anything**, because
   no `ANTHROPIC_API_KEY` is configured and 342 of 353 rubrics are unsigned.

Read [README.md](./README.md) for the content pipeline and [docs/PLATFORM.md](./docs/PLATFORM.md)
before writing any server code — it is the contract every route was built against.

## The rule that shapes the most code

**Refuse rather than guess.** It recurs at every layer and is not negotiable:

- The paper harvest ships 36 of 66 papers with `sectionsDerived: false` rather than a
  guessed mark grid, and `/practice` presents those read-only.
- The rubric extractor refused 702 of 1000 questions; the exemplar extractor refused 242.
- A rubric flagged `needsReview` may award green and orange but **may never paint red** —
  so an unsigned rubric can only ever be generous, which is why nothing measured against
  one means anything yet.
- A `diagram` step is never auto-graded. It resolves to `unmarked`, which writes **no
  highlight span at all** — there is deliberately no fourth `HighlightColor`, because a
  colourless span would be rendered red by the first renderer that forgot to skip it.
- An unmarked written answer scores `null`, never `0`. Only a student saying "I left this
  blank" scores zero.

## Non-obvious things to know

### Content
- **The PDFs must be mirrored.** ncert.nic.in sends no `Access-Control-Allow-Origin` and
  `X-Frame-Options: SAMEORIGIN`, so a browser cannot fetch or iframe them cross-origin.
- **Exemplar PDFs live at a different path** from textbooks:
  `pdf/publication/exemplarproblem/classIX/mathematics/…`, segmented by class and subject.
  Probing the unsegmented directory reports every unit missing while the files are there.
- **`data/manifest.json` is generated, never hand-edited.** `npm run content:manifest` must
  preserve `bytes`/`sha256` or it re-downloads 509 MB and blanks the sizes in the UI.
- **Never precache the PDFs.** `public/sw.js` only ever *serves* from `ncert-pdfs-v1`;
  entries are put there solely by an explicit user download in `src/lib/offline.ts`.
- **Chapter titles are recovered from the PDFs.** 44 of 149 (the Hindi books) use a legacy
  8-bit Devanagari font and cannot be extracted. Prefer a plain label to a wrong one.
- **Never map an Exemplar unit to a chapter by title.** `iesc1` ch8 "Journey Inside the
  Atom" is atomic structure and ch9 "Atomic Foundations of Matter" is the laws of chemical
  combination — a title match swaps two whole units. Extract section headings and read them.
- **Superscripts, subscripts and radicals do not survive pdf.js.** `9√3 cm²` extracts as
  `9 3 cm`. Detect by *baseline*, not type size: the numerals inside a radical are set at
  full body height. Two questions shipped corrupted before this was caught by hand.
- **`jeep1` is typeset in two broken fonts**, one page-set shifted 29 code points
  (`:KLFK RI WKH IROORZLQJ`). The offset is scored by English function-word count, never
  guessed.
- **Rationalisation (2023) cut content the Exemplar still tests.** 16 questions carry an
  out-of-syllabus label *in the question stem* — not a new field, because `src/lib/quiz.ts`
  normalises a fixed field set and would silently drop one.

### Class 9 has no board exam
CBSE publishes **no Class 9 papers and no marking schemes** — confirmed, every URL 404s. So
there is nothing to grade *against* for Class 9, and it is a preparation product, not a
grading one. Its questions come from NCERT Exemplar (Science and Maths, which have answer
keys) and from authoring (Social Science). English is deliberately not keyword-graded:
CBSE marks it holistically, and a colour overlay on an essay would be worse than nothing.

### The app
- **`data/questions.json` is authored; `questions.exemplar.json` is generated.** `quiz.ts`
  reads three banks and concatenates them, authored first so it wins on a duplicate id.
  Never merge them — the next extraction run would overwrite hand-written work.
- Class and subject come from `bookCode` via the manifest and **override whatever a row
  claims**, so a question cannot be mis-filed class-wise.
- **A finished quiz, test or paper writes one SM-2 card per chapter, not per question.** It
  is the same card `ChapterRating` writes, which is why `/revise` and `/progress` need no
  feature-specific code. Preserve that property in anything new.
- **The exam clock is derived, never accumulated** — `startedAt + durationMs - now`. A phone
  backgrounds the tab across three hours and a counted clock drifts or dies. Pacing obeys
  the same rule: one wall-clock stamp per section, everything else recomputed.
- **`clientAttemptId` is the idempotency key** for syncing a sitting. It is the Dexie key, so
  a retry updates rather than forking one exam into two.
- Syncing is opportunistic: offline, 401 and 500 are all "not now". **A student mid-exam must
  never be blocked or lose work.**
- **The service worker only registers in production builds** — test offline with
  `npm run build && npm start`, not `npm run dev`. `sw.js` precaches `/offline/` **with the
  trailing slash**: `next start` 308s the slashless form, `addAll` caches the redirect, and a
  redirected response can never satisfy a navigation.
- `react-hooks/set-state-in-effect` is an **error** here. Use the `.then` + `live` guard shape
  in `RevisionQueue.tsx`, not `useCallback` + `useEffect`.

### The server
- **The acting user and scope come from the session, never a request body.** The spec this
  replaced read an admin id out of `req.body`, which is an impersonation hole.
- **`trailingSlash: true` applies to route handlers.** POST to `/api/x/` or it 308s and the
  body silently vanishes.
- Grading is **append-only**: a human override inserts a new revision with `supersedesId`,
  never mutating the AI's verdict. A student is entitled to see that a human changed it.
- The evaluator queue claims with one conditional `UPDATE … FOR UPDATE SKIP LOCKED`. No Redis.
- The wallet ledger lives in its **own `ledger` Postgres schema**, outside Prisma's migration
  engine, created at runtime under an advisory lock.
- Local Postgres is Docker `ncert-pg` on host port **5433** — 5432 belongs to another project.
- In production `DATABASE_URL` is pooled and `DIRECT_URL` is not. With a transaction pooler a
  session-level `SET` leaks across requests; tenant scoping must use `set_config(..., true)`
  inside the transaction.

## Deploying

Not deployed. Read [DEPLOY.md](./DEPLOY.md) and [PERMISSIONS.md](./PERMISSIONS.md) first:
serving the mirrored corpora publicly is blocked on a permission request that is **still
unsent**, and `.vercelignore` is what stops a CLI deploy publishing 342 MB of it by accident.

## Checks

```bash
npx tsc --noEmit && npx eslint .     # both must be clean
npm test                             # offline: SM-2, pacing, bridges, dual-track,
                                     # grading, shadow, parent, and every data validator
npm run build && npm start           # then, in another shell:
node scripts/smoke.mjs        http://localhost:3222   # 12 reader checks
node scripts/smoke-quiz.mjs   http://localhost:3222   # marking, score, SM-2 card
node scripts/smoke-mobile.mjs http://localhost:3222   # tap targets, truncation, overflow
node scripts/smoke-pwa.mjs    http://localhost:3222   # service worker, offline fallback
node scripts/smoke-journey.mjs http://localhost:3222  # the whole student path, 105 checks
```

Every suite asserts it is talking to *this* build before running. A bare readiness probe
once passed against a zombie server and produced four suites of confident, fictitious
failures.
