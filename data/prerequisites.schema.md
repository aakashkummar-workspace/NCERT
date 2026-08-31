# `data/prerequisites.json` — the micro-bridge contract

A **bridge** says what a chapter leans on: which *earlier* chapter in this
corpus a student needs before this one will make sense, why, and the two or
three lines that get them back on their feet in under three minutes. Run
`npm run bridge:check` before committing.

This is the third of the authored files, after
[`questions.schema.md`](./questions.schema.md) and
[`rubrics.schema.md`](./rubrics.schema.md), and it inherits their two rules:

1. **A bridge that does not validate is not used.** `src/lib/bridge.ts` drops
   anything it cannot trust, silently, because a wrong prerequisite sends a
   student who is already stuck to the wrong chapter. `bridge:check` is where
   that is reported loudly, so nothing goes missing without a reason.
2. **Class and subject come from `bookCode`, not from the row.** The manifest
   already knows `jesc1` is Class 10 Science. Nothing here restates it.

Two more rules are specific to this file, and both are the point of it.

## Rule 1 — a prerequisite is always earlier, never elsewhere

A prerequisite must be one of:

- a chapter in a **lower class** (Class 9 for a Class 10 chapter), or
- an **earlier chapter in the same book** (`jesc1` ch 9 for `jesc1` ch 10).

Same class, different book is a **hard error**. Nothing in the corpus orders
`jemh1` against `jesc1` — a student does not read Maths chapter 3 before
Science chapter 11 in any defined sense — so a link across them would be a
claim the data cannot support, and it is the one shape that could put two
chapters in a loop.

That rule alone makes the graph acyclic. `bridge:check` still runs a cycle
detection over it, because a cycle is the failure that matters most: a student
bounced from chapter A to chapter B to chapter A has been given a treadmill
instead of help, and would never work out why.

## Rule 2 — an honest gap beats a wrong link

The corpus is Class 9 and 10 only. Where a chapter's real prerequisite is
Class 7 or 8 work, **say so** rather than pointing at the nearest Class 9
chapter that shares a word with it. Class 10 Statistics builds on mean, median
and mode; the Class 9 NCF Mathematics book has no statistics chapter; so
`jemh1-13` carries one `out-of-corpus` prerequisite and no in-corpus link, and
the app never offers it as a review. This is the same instinct as chapter
titles in [`CLAUDE.md`](../CLAUDE.md): prefer a plain label to a wrong one.

Four bridges are currently gap-only — Class 10 Triangles, Statistics and
Light, plus Class 9 Probability. They are worth keeping in the file even
though they are never offered: they record *why* nothing is offered, so nobody
has to rediscover the absence.

## File

```jsonc
{
  "generatedAt": "2026-08-31",
  "source": "where these came from",
  "bridges": [ /* … */ ]
}
```

A bare top-level array is also accepted, as is `{ "items": [...] }`. Anything
else is a hard error.

## One bridge

```jsonc
{
  "id": "jemh1-04",              // required, unique across the file
  "bookCode": "jemh1",           // the chapter this bridge is FOR
  "chapter": 4,                  // must exist in that book
  "concept": "Completing the square",   // optional — see below
  "questionIds": ["jesc1-01-005"],      // optional — ids in data/questions.json
  "prerequisites": [ /* one or more, in the order a student should read them */ ]
}
```

`bookCode` + `chapter` (+ `concept`, when present) must be unique. A chapter
may carry one chapter-level bridge and any number of concept-level ones.

### `concept`

Omit it and the bridge is the chapter's general run-up, offered when the
chapter as a whole looks weak. Give it, and the bridge is narrower: it is
offered when *that idea* is the thing that went wrong, which `questionIds` or
the caller's own concept tag identifies. A concept bridge is preferred over
the chapter bridge whenever both apply — it is shorter, and it is about the
actual mistake.

### One prerequisite, in corpus

```jsonc
{
  "kind": "chapter",
  "bookCode": "iemh1",
  "chapter": 4,
  "minutes": 1,               // 1–3, honest; the UI states it before the student commits
  "why": "…",                 // one line, in the student's language, saying what it unlocks
  "recap": ["…", "…", "…"]    // 2–4 lines that ARE the review
}
```

`recap` is not a summary of the chapter. It is the smallest thing that makes
the next chapter possible, written so it can be read standing up. Two or three
lines; the fourth is usually one too many.

`minutes` is a promise. The sum of `minutes` across a bridge's in-corpus
prerequisites must be **3 or less** — the feature is a micro-bridge, and a
student who is told "2 minutes" and given eight has been lied to once and will
not accept the offer again.

### One prerequisite, out of corpus

```jsonc
{
  "kind": "out-of-corpus",
  "grade": 7,                 // 6, 7 or 8
  "topic": "Light: reflection and plane mirrors",
  "why": "…",                 // required — what it unlocks, same as above
  "note": "…"                 // optional — why the corpus cannot cover it
}
```

No `recap` and no `minutes`: there is nothing here to open, and pretending
otherwise is what this shape exists to prevent. The UI shows these as a plain
note under the review, never as a step.

## Rejected, with the reason `bridge:check` gives

- duplicate `id`, or a duplicate `bookCode` + `chapter` + `concept`
- `bookCode` not in `data/manifest.json` (target or prerequisite)
- `chapter` outside that book's range (target or prerequisite)
- a prerequisite pointing at its own chapter
- a prerequisite that is not earlier — a higher class, a later chapter in the
  same book, or a different book in the same class
- a cycle anywhere in the graph
- no `prerequisites` at all
- an in-corpus prerequisite with no `recap`, or with `minutes` outside 1–3
- in-corpus `minutes` summing to more than 3 for one bridge
- an `out-of-corpus` prerequisite with no `grade`, `topic` or `why`
- an unknown `kind`

Warned about, but still shipped: a bridge with only out-of-corpus
prerequisites (correct, but never offered); a `questionIds` entry that is not
in `data/questions.json` (the bank is sparse, so this is usually a bank that
has not caught up); a `recap` line over 200 characters (too long to read
standing up).

## Adding bridges incrementally

Append to `bridges`; nothing is positional. The file is imported at build time
and baked into the static export, so `npm run build` is what publishes a new
bridge — and a new `bookCode` + `chapter` pair also adds a prerendered route
under `/bridge/`.
