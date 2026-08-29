# NCERT Quick

A free, offline-first reader for NCERT Class 9 and Class 10 textbooks. Installable as a PWA,
built as a fully static Next.js export, with every chapter downloadable for offline reading.

**17 books · 149 chapters · Science, Mathematics, Social Science, English and Hindi.**

---

## Why the PDFs are mirrored

ncert.nic.in serves its chapter PDFs with **no `Access-Control-Allow-Origin` header** and
**`X-Frame-Options: SAMEORIGIN`**. A browser therefore cannot `fetch()` them into pdf.js and
cannot `<iframe>` them from another origin. Fetching from ncert.nic.in at runtime is not a
design choice we rejected — it is impossible in a web app. Serving copies from our own origin
is the only way an in-app reader can work at all.

See [PERMISSIONS.md](./PERMISSIONS.md) for the copyright position and mitigations.

## How the content pipeline works

NCERT publishes no API. The catalogue is embedded in `ncert.nic.in/textbook.php` as an inline
JavaScript cascade, and chapter PDFs follow a predictable code scheme:

```
https://ncert.nic.in/textbook/pdf/{code}{NN}.pdf     jesc101.pdf = Class 10 Science, ch.1
                                  ^^^^  ^^
code = [class][medium][subject][book#]     i = IX, j = X · e = English, h = Hindi
```

Four scripts turn that into `data/manifest.json`, which every page in the app is generated from:

| Script | Does |
| --- | --- |
| `npm run content:catalogue` | Parses `textbook.php`, skipping the `//`-commented entries that mark withdrawn books → `data/catalogue.raw.json` |
| `npm run content:manifest` | Filters to Class 9/10 core subjects → `data/manifest.json` |
| `npm run content:pdfs` | Mirrors every chapter PDF into `public/ncert/<code>/`. Resumable, checksummed, rate-limited |
| `npm run content:titles` | Recovers chapter titles (see below) |

`npm run content` runs all four in order. Every step is safe to re-run: the downloader skips
files whose sha256 already matches, and the title extractor keeps titles it has already found.

### Chapter titles

NCERT labels every chapter generically ("Chapter 1") and publishes titles **nowhere** on its
site, so they are recovered from the PDFs themselves, in order of reliability:

1. `data/title-overrides.json` — hand-curated, always wins
2. The Contents page of the book's prelims PDF (`<code>ps.pdf`)
3. The running header on the chapter's own early pages
4. The largest type on the chapter's first page

Anything unresolved keeps the "Chapter N" label — the same thing ncert.nic.in shows — rather
than a mangled guess.

**Current state: 105 of 149 titles resolved.** The 44 remaining are the Class 9 and 10 Hindi
books (`ihga1`, `jhkr1`, `jhks1`, `jhsp1`, `jhsy1`), which are typeset in a legacy 8-bit
Devanagari font that extracts as mojibake. To fix them, read the real titles off the book and
add them to `data/title-overrides.json`:

```bash
npm run content:dump -- jhks1 --all   # prints the prelims text to curate from
npm run content:titles                # re-run; overrides are applied first
```

### Keeping up with NCERT

Class 9 moved to the new NCF books for 2025-26 (Science *Exploration*, Maths *Ganita Manjari*,
English *Kaveri*, Social Science *Understanding Society*); Class 10 is still on the older set
and will follow. Because the manifest is generated rather than hand-typed, re-running
`npm run content` picks up the change.

## Running it

```bash
npm install
npm run content     # first time only — downloads ~509 MB of PDFs
npm run dev         # http://localhost:3000
```

`npm run build` produces a static `out/` directory. `npm start` serves it locally.

> The service worker is registered in production builds only, so offline behaviour must be
> tested against `npm run build && npm start`, not `npm run dev`.

## Architecture

```
scripts/           content pipeline (Node, run manually)
  lib/ncert.ts     shared types, code scheme, fetch-with-retry
data/
  manifest.json    generated — the single source of truth for the app
  title-overrides.json
  questions.json   quiz question bank — authored, not generated
  questions.schema.md  the contract anything writing questions must follow
src/lib/
  manifest.ts      typed access to the manifest; every route reads through this
  offline.ts       Cache Storage: download / delete / list / storage estimate
  reading-state.ts IndexedDB (Dexie): last page read, bookmarks
  quiz.ts          normalises + slices the question bank at build time
  quiz-attempts.ts quiz results, and the SM-2 card each one writes
src/components/
  PdfReader.tsx    pdf.js viewer — zoom, search, resume, chapter nav
  PdfPage.tsx      one page; renders only near the viewport, releases when far
  QuizRunner.tsx   one question at a time, marked on answer
public/
  ncert/<code>/    mirrored chapter PDFs (gitignored, ~509 MB)
  sw.js            hand-written service worker
```

### Two caches, on purpose

- **`ncert-shell-v1`** — app shell, network-first for navigations.
- **`ncert-pdfs-v1`** — chapter PDFs, populated *only* by an explicit download.

At ~509 MB total, and 17.7 MB for the largest single chapter, nothing about the textbook corpus
can be precached. The service worker never adds a PDF to the cache on its own; it only serves
what `src/lib/offline.ts` put there when a student tapped download.

## Quiz questions

The textbooks ship no answer keys, so nothing here can be extracted from the PDFs. The bank in
`data/questions.json` is authored — by hand or by an agent — against the contract in
[`data/questions.schema.md`](data/questions.schema.md), and validated with:

```bash
npm run quiz:check
```

Two rules matter more than the rest:

- **The manifest decides class and subject, not the question.** A question tagged `"class": 9`
  on book `jesc1` is filed under Class 10, because `jesc1` is a Class 10 book. Mis-filing a
  question class-wise is the one error a student could never detect, so it is made impossible
  rather than merely discouraged. `quiz:check` reports the disagreement.
- **The app drops what it cannot trust, silently.** A question with an unresolvable answer never
  reaches a student. That is right for the student and useless for the author, which is exactly
  why `quiz:check` exists — it prints every rejection with its reason and its id.

Questions are imported at build time and sliced per subject, so a phone downloads Class 10
Science and nothing else. Adding questions therefore needs `npm run build` to publish them.

Finishing a quiz writes **one SM-2 card per chapter** — the same card a chapter self-rating
writes — so `/revise` and `/progress` pick the result up with no extra wiring. Per-question
cards were rejected deliberately: they would flood the revision queue with one-mark MCQs and
leave the weak-area dashboard unable to join them back to a chapter.

## Deploying

The `out/` directory is static. Cloudflare Pages suits it best: the largest chapter (17.7 MB)
clears the 25 MB per-file limit, and bandwidth is free. The content pipeline should run in CI
before `next build` so the PDFs are present at export time.
