# `data/questions.json` — the quiz question contract

Anything that generates questions writes **this** shape. Run `npm run quiz:check`
before committing; it reports every problem with the offending `id`, and the app
silently drops any question that does not survive normalisation, so a file that
does not validate is a file whose questions never reach a student.

## File

```jsonc
{
  "generatedAt": "2026-08-29",
  "source": "where these came from",
  "questions": [ /* … */ ]
}
```

A bare top-level array is also accepted, as is `{ "items": [...] }`. Anything
else is a hard error.

## One question

```jsonc
{
  "id": "jesc1-01-001",        // required, unique across the file
  "class": 10,                 // 9 | 10
  "subject": "Science",        // must match a subject name in data/manifest.json
  "bookCode": "jesc1",         // NCERT book code from data/manifest.json
  "chapter": 1,                // must exist in that book
  "type": "mcq",               // mcq | assertion-reason | true-false
  "question": "…",             // the stem, plain text
  "options": ["…", "…", "…", "…"],   // 2–6 entries, all distinct
  "answer": 0,                 // 0-based index into options
  "explanation": "…",          // why that option is right — shown after answering
  "marks": 1,
  "difficulty": "easy"         // easy | medium | hard
}
```

### Which fields actually matter

`bookCode` + `chapter` are the load-bearing pair. **`class` and `subject` are
derived from `bookCode`** via the manifest and will override whatever the file
says — a question tagged `"class": 9` on book `jesc1` is filed under Class 10,
because the book is a Class 10 book. That is deliberate: it makes it impossible
to mis-file a question class-wise, which is the one error a student would never
detect. `quiz:check` reports the disagreement so it can be fixed at source.

A question with no recognisable `bookCode` is kept only if its `class` and
`subject` match the manifest. It then appears in that subject's mixed quiz but
under no chapter, and feeds nothing into the weak-area dashboard.

### Tolerated spellings

The loader normalises these rather than dropping the row, so a generator that
uses common alternatives still works:

| Canonical | Also accepted |
|---|---|
| `class` | `classNum`, `grade` |
| `bookCode` | `book`, `code` |
| `chapter` | `chapterNo`, `chapterNumber`, `ch` |
| `question` | `text`, `stem`, `q` |
| `options` | `choices`, `opts` |
| `answer` | `answerIndex`, `correct`, `correctIndex`, `correctAnswer`, `correctOption` |
| `explanation` | `solution`, `reason`, `rationale` |
| `type` | `questionType`, `format` |

`answer` may be a 0-based index, a letter (`"A"`, `"c"`), a 1-based position
when it cannot be an index, or the exact text of the correct option. Ambiguity
resolves toward the index reading; `quiz:check` prints how each one was read.

## Rejected, with the reason `quiz:check` gives

- duplicate `id`
- fewer than 2 options, or duplicate option text
- `answer` outside the options range, or unresolvable
- `bookCode` not in the manifest
- `chapter` outside that book's chapter range
- empty `question`

## Adding questions incrementally

Append to `questions`; nothing is positional. Re-running the app needs a
rebuild, because the file is imported at build time and baked into the static
export — `npm run build` is what publishes new questions.
