# NCERT Quick — working notes

Offline-first PWA reader for NCERT Class 9 & 10 textbooks. Static Next.js export.
Read [README.md](./README.md) first; it documents the content pipeline in full.

## Non-obvious things to know

- **The PDFs must be mirrored.** ncert.nic.in sends no `Access-Control-Allow-Origin` and
  `X-Frame-Options: SAMEORIGIN`, so a browser cannot fetch or iframe them cross-origin.
  Runtime-fetching from NCERT is impossible, not merely undesirable. See PERMISSIONS.md.
- **`data/manifest.json` is generated, never hand-edited.** It is the single source of truth
  for every route. To change content, change the pipeline in `scripts/` and re-run it.
- **`npm run content:manifest` must preserve `bytes`/`sha256`.** Dropping them re-downloads
  509 MB and blanks the chapter sizes shown in the UI.
- **Never precache the PDFs.** The corpus is ~509 MB, largest chapter 17.7 MB. `public/sw.js`
  only ever *serves* from `ncert-pdfs-v1`; entries are put there solely by an explicit user
  download in `src/lib/offline.ts`.
- **Chapter titles are recovered from the PDFs**, because NCERT publishes none. 44 of 149
  (the Hindi books) use a legacy 8-bit Devanagari font and cannot be extracted; they keep
  "Chapter N" until curated into `data/title-overrides.json`. Prefer a plain label to a wrong one.
- **`data/questions.json` is authored, not generated** — the opposite of `manifest.json`.
  NCERT ships no answer keys, so nothing can be extracted. `data/questions.schema.md` is the
  contract; `npm run quiz:check` validates it. Class and subject come from the `bookCode` via
  the manifest and override whatever the question claims, so a question cannot be mis-filed
  class-wise. Questions are baked in at build time — adding them needs `npm run build`.
- **A finished quiz writes one SM-2 card per chapter, not per question.** It is the same card
  `ChapterRating` writes, which is why `/revise` and `/progress` need no quiz-specific code.
- **The service worker only registers in production builds**, so test offline behaviour with
  `npm run build && npm start`, not `npm run dev`.
- **Class 9 is on the new NCF books, Class 10 is not (yet).** Withdrawn books are the
  `//`-commented entries on NCERT's catalogue page; the scraper relies on that.

## Checks

```bash
npx tsc --noEmit && npx eslint .     # both must be clean
npm run build && npm start           # then, in another shell:
node scripts/smoke.mjs http://localhost:3222        # 12 browser checks
node scripts/smoke-quiz.mjs http://localhost:3222  # quiz: marking, score, SM-2 card
node scripts/smoke-mobile.mjs http://localhost:3222  # tap targets, truncation, overflow
```
