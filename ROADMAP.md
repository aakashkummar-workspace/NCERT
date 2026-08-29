# Roadmap

Phased build plan for NCERT Quick, from working reader to exam-prep tool.

Every claim here was verified against the live sources rather than assumed. Where something was
**disproved**, it is marked — those notes save the most time later.

---

## Phase 0 — Reader — ✅ done

| | |
| --- | --- |
| Content | 17 books, 149 chapters, 509 MB mirrored from ncert.nic.in |
| App | Static Next.js export, 168 prerendered pages, installable PWA |
| Reader | pdf.js, virtualised pages, zoom, in-chapter search, resume |
| Offline | Per-chapter download, Cache Storage, downloads manager |
| Verified | `smoke.mjs` 12/12, `smoke-pwa.mjs` 4/4, `tsc` + `eslint` clean |

**Load-bearing constraint:** ncert.nic.in sends no `Access-Control-Allow-Origin` and
`X-Frame-Options: SAMEORIGIN`. Browsers cannot fetch or iframe those PDFs cross-origin, so
mirroring is mandatory, not a preference. See [PERMISSIONS.md](./PERMISSIONS.md).

---

# Main track — exam preparation

The spine of the product. Each phase feeds the next; Phase 4 is the engine everything else exists
to supply.

## Phase 1 — Make the syllabus authoritative — ✅ done

- [x] CBSE curriculum PDFs → **unit-wise marks weightage** (`scripts/build-syllabus.ts`).
- [x] Units mapped to chapters; surfaced as *"Chemical Substances — 25 marks — chapters 1–4."*
- [x] `src/lib/syllabus.ts` accessor: `unitsByWeight`, `marksPerChapter`, `chapterRangeLabel`.

**All 8 subjects reconcile** — unit marks sum to 80 in every case. Seven are checked against a
total the PDF itself prints; Class 9 Social Science prints none, so its total is the sum of its
four 20-mark disciplines, and the run output says so rather than implying a verified figure.

**Class 10 is complete: 100% of chapters mapped across all four subjects, hand-verified.**

⚠️ **Class 9 unit→chapter mapping is mostly impossible, and this is a real finding rather than a
weak extractor.** CBSE's 2025-26 Class IX syllabus is still written against the *previous* NCERT
books while the app carries the new NCF ones: the syllabus prescribes Beehive/Moments where the
manifest has `iebe1` *Kaveri*, and four separate Social Science books where the manifest has one
combined `iest1` *Understanding Society*. Unmapped: English 3/3 units, Social Science 4/4,
Maths 4/6, Science 1/4. The **marks weightage is still fully correct** for Class 9 — only the
join to chapters is missing, so a student still sees "Motion, Force and Work — 27 marks".
Revisit when CBSE republishes the Class IX syllabus against the NCF books.

**Why first:** a student working chapters 1→13 in order is optimising nothing. Weightage tells
them where the marks actually are. Works identically for Class 9 and 10.

## Phase 2 — Official question bank — ✅ done

- [x] Mirror the **140 CBSE sample papers + marking schemes** (~140 MB, English and Hindi).
      Same pipeline and same CORS situation as the textbooks.
- [x] Attach each paper to its subject — one tap from the chapter list.
- [x] Also fetch the **NCERT answer keys** (`an` files, e.g. `jesc1an.pdf` — confirmed live).
      These are what Class 9 self-checks against in Phase 3, so they are not optional.

**Disproved — do not re-plan these:**
- CBSE publishes **no Class 9 sample papers**; `SQP_CLASSIX*` returns 404.
- NCERT **Exemplar is withdrawn**; `jeep101.pdf` and `ieep101.pdf` both 404.

⚠️ Adds CBSE material to the existing NCERT copyright exposure — record in PERMISSIONS.md.
⚠️ Pushes the payload past 650 MB. See *Compression* below; it stops being optional here.

## Phase 3 — Practice mode — ✅ done

- [x] Open a paper with a **timer running**, marking scheme hidden. The countdown is derived from
      a wall-clock stamp, not accumulated from ticks, so it survives a phone locking mid-exam.
- [x] On finish, reveal the scheme; student self-scores per question.
- [x] Store scores per attempt; attempt history per paper.
- [ ] ⚠️ **Class 9 has no self-check source at all.** CBSE publishes no Class 9 papers *and*
      NCERT ships no answer keys for the new NCF Class 9 books (`iesc1an`/`iemh1an`/`iest1an`/
      `iebe1an` all 404; only `jesc1an` and `jemh1an` exist, both Class 10). The original plan
      — NCERT back exercises checked against the Phase 2 `an` answer keys — is therefore not
      possible. `/practice` says so plainly rather than offering a broken flow. Needs re-planning:
      the likely answer is self-rated confidence on chapter exercises with no answer key, which
      still feeds SM-2 because SM-2 runs on self-rating, not on objective correctness.

**Ships on self-scoring alone.** Auto-grading is a later, per-subject addition (Phase 6) and this
phase must not block on it.

**Why self-scoring is not a compromise:** boards are handwritten and hand-marked in 180 minutes.
Reading the marking scheme teaches students *how marks are awarded* — itself an exam skill.

## Phase 4 — Spaced revision — ✅ done

**The actual learning engine. Everything before it just feeds this.**

- [x] Every self-scored question becomes a card with a confidence rating.
- [x] SM-2 scheduler (`src/lib/revision.ts`), verified by `scripts/test-sm2.mjs` — 12/12,
      including that ease never falls through the 1.3 floor and streaks keep growing.
- [x] Daily revision queue at `/revise`.
- [x] All in IndexedDB. No backend.

Four confidence buttons (again/hard/good/easy) rather than SM-2's raw 0–5: students cannot
calibrate six levels honestly, and self-assessment is already noisy.

Depends only on Phase 3 self-scores — **not** on auto-grading.

## Phase 5 — Weak-area dashboard — ✅ done

- [x] `/progress` crosses Phase 1 weightage against Phase 4 confidence.
- [x] Ranks units by **marks at risk**, so the top row is genuinely what to study next.

**Untested ≠ weak.** A chapter with no revision cards shows as "not tested yet", never as a
weakness — inventing one sends a student to the wrong chapter just as surely as hiding a real
one. Marks-at-risk is computed only across chapters that actually have cards. Class 9 units with
no chapter mapping say so explicitly instead of reporting "0 chapters".

---

# Parallel track — reader polish

Independent of the main track; none of it blocks Phases 1–5. Pick up between phases.

- [x] **Compression.** ✅ 509.3 MB → 253.5 MB (**50% saved**). Ghostscript 10.07.1, images
      downsampled to 150 dpi. Originals kept in `data/ncert-original/`; `sha256` re-recorded so
      `content:pdfs` does not re-download.

      ⚠️ **Never use `-dPDFSETTINGS=/ebook` or `/printer` here.** Both silently drop images —
      measured on `jemh101`, 3 image operations became 1, and what vanished was NCERT's own
      "not to be republished" watermark. Text was byte-for-byte identical, so no automated test
      caught it; it was found by eye against a pre-compression screenshot. The preset saved 60%
      against explicit downsampling's 50%, and those 10 points are not worth stripping a rights
      holder's copyright notice off a file we are already republishing without permission.
      Fidelity is now spot-checked across 6 chapters: page count, image operations and character
      counts all match the originals exactly.
- [ ] **44 Hindi chapter titles.** `ihga1`, `jhkr1`, `jhks1`, `jhsp1`, `jhsy1` use a legacy 8-bit
      Devanagari font that extracts as mojibake. Curate into `data/title-overrides.json` via
      `npm run content:dump -- <code> --all`.
- [x] **Bookmarks UI.** ✅ `/bookmarks`, with a toggle in the reader toolbar. Known limit: rows
      link to the chapter and resume at the last-read page, not the bookmarked page — the reader
      has no page deep-link yet (Phase 7).
- [x] **Night reading mode.** ✅ Inversion applied to the page *sheet*, not the canvas, so
      unrendered placeholders do not flash white against rendered dark pages.
- [ ] **Full-text search** across all 149 chapters — build-time MiniSearch/lunr index (~5–10 MB).
- [ ] **Deploy** to Cloudflare Pages (largest chapter 17.7 MB, inside the 25 MB file cap).

---

# Later

## Phase 6 — Auto-graded MCQs

Real, but a parsing project — not a quick win.

- [ ] **Layout-aware extractor** using pdf.js text coordinates. The papers are tables
      (`Q.No | Question | Marks`); read the narrow left column as question numbers.
- [ ] Per-subject extractors — marking-scheme conventions differ by subject.
- [ ] **Human verification gate before shipping any key.**
- [ ] MCQ quiz mode with instant scoring and the official explanation.

**Prototype result (naive regex on flattened text):** Science 11 gradable, Maths 0, Social
Science 0 — and the one sample produced was wrong, matching `1 𝑣 + 1 𝑢` inside a lens formula as
"question 1". Flattened text is insufficient; coordinates are required.

**Rule:** a wrong answer key is worse than no answer key — it teaches the wrong thing to someone
who trusts it. Same principle that left 44 chapter titles as "Chapter N".

## Phase 7 — Reach

- [ ] **Hindi medium** — `jhsc101.pdf` and `jhmh101.pdf` confirmed live; `lib/manifest.ts` was
      written medium-aware from the start. Roughly doubles the audience.
- [ ] **Read aloud** via the pdf.js text layer + `SpeechSynthesis`.
- [ ] Page thumbnails and quick jump.
- [ ] Shareable deep links to an exact page.

---

# Cross-cutting

**Permission requests — blocks public launch, not development.** NCERT (`pd.ncert@nic.in`) now,
CBSE from Phase 2. Neither sent. Tracked in [PERMISSIONS.md](./PERMISSIONS.md).

**Catalogue drift.** Class 9 has moved to the new NCF books; Class 10 will follow. A
`check-catalogue-drift.ts` diffing the live catalogue against the committed manifest would catch
that automatically. The manifest is generated, so a re-run absorbs the change.

**No backend, by design.** Progress, downloads and revision state live on one device — which is
what makes the app free to host anywhere. Cross-device sync would need a server; a QR or file
export/import can move state without one.
