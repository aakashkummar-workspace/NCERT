/**
 * Phase 2, step 2 — draft marking rubrics from CBSE's own marking schemes.
 *
 *   npx tsx scripts/extract-rubrics.ts
 *   npx tsx scripts/extract-rubrics.ts --paper class10-science-2025-26
 *   npx tsx scripts/extract-rubrics.ts --explain class10-science-2025-26:13
 *
 * WHY THIS EXISTS
 * ---------------
 * data/rubrics.json is authored, not generated, and it says so: CBSE's schemes
 * are prose written for a human examiner. 23 rubrics were hand-converted from
 * three schemes; public/papers/ now holds 64. Hand-converting the rest is weeks
 * of work, and most of it is mechanical — so this script does the mechanical
 * part and refuses the rest, writing **drafts** to data/rubrics.draft.json for
 * a teacher to sign off. It never writes data/rubrics.json.
 *
 * WHAT IT REFUSES, AND WHY THAT IS THE POINT
 * ------------------------------------------
 * The one error data/rubrics.schema.md calls "the single most damaging" is
 * steps that do not sum to maxMarks, because it grades every attempt at that
 * question out of the wrong denominator. So the sum is not something this
 * script computes — it is something it *reads out of the scheme* and checks:
 *
 *   - CBSE prints a marks column on the right of every scheme. Where it carries
 *     a per-step split (the Maths schemes, and the older Science ones), each
 *     token becomes one step, and the rubric is emitted only if those tokens
 *     sum to the marks data/papers.json allots the question.
 *   - Where it carries one total for the whole answer (most of the 2025-26
 *     Science scheme), there is no split to read, and the only honest rubric is
 *     one CBSE itself spelled out: "any two of the following" over an
 *     enumerated list, which is a `choose` group whose arithmetic is given.
 *   - Everything else is refused, with the reason recorded in `rejects`.
 *
 * The same standard the harvest applied to mark grids — 36 of 66 papers were
 * published with `sections: []` rather than a plausible guess — is applied here
 * to rubrics. Only the 30 papers with `sectionsDerived !== false` are processed
 * at all: without a trustworthy mark grid there is no denominator to check the
 * scheme's tokens against, and a rubric checked against a guessed total is not
 * checked.
 *
 * WHAT IT INFERS, AND SAYS SO
 * ---------------------------
 * Two things cannot be read off the scheme and are inferred. Both are named in
 * every rubric's `reviewNotes`, and every emitted rubric is `needsReview: true`
 * — which, per the schema, means a grader may paint it green or orange but
 * never red until a teacher has signed it off.
 *
 *   1. `chapter`. A rubric with no chapter has nowhere to send its result, so
 *      the schema rejects one outright. CBSE tags nothing. The chapter is
 *      recovered the way chapter titles were: from the mirrored NCERT PDFs. Each
 *      Class 10 chapter of the paper's subject is read into a tf-idf profile,
 *      the question's own text is scored against all of them, and the chapter is
 *      accepted only if the best match is decisively ahead of the runner-up.
 *      Otherwise the question is refused. Measured against the 23 hand-authored
 *      rubrics, this agrees with the human on most and is reported per run.
 *   2. `keywords`. A step's concepts are the most distinctive terms of the
 *      scheme's own wording for that step, kept as ONE concept — so a student
 *      needs any one of them, not all. That is deliberately lenient: a draft
 *      rubric should fail to award a mark it was owed far more readily than
 *      award one it was not, and it may not paint red at all. Splitting them
 *      into real concepts is the reviewer's job, and the review note says so.
 *
 * IDEMPOTENT
 * ----------
 * The output is a pure function of data/papers.json, data/manifest.json,
 * data/syllabus.json, data/rubrics.json and the mirrored PDFs. It carries the
 * paper index's own `generatedAt` rather than the wall clock, so a second run
 * over unchanged inputs writes an identical file.
 *
 * Questions already covered by a hand-authored rubric in data/rubrics.json are
 * skipped, so the draft file can be concatenated onto it without a duplicate id
 * or a duplicate paper+questionNo+variant.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { PDFDocumentProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import type { Manifest } from "./lib/ncert";

const PAPERS_JSON = "data/papers.json";
const MANIFEST_JSON = "data/manifest.json";
const SYLLABUS_JSON = "data/syllabus.json";
const RUBRICS_JSON = "data/rubrics.json";
const PAPER_DIR = "public/papers";
const NCERT_DIR = "public/ncert";
const OUT = "data/rubrics.draft.json";

/** Several NCERT and CBSE PDFs use legacy CID encodings; see extract-titles.ts. */
const FONT_OPTS = {
  cMapUrl: "node_modules/pdfjs-dist/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  useSystemFonts: true,
} as const;

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

// ─────────────────────────────────────────────────────────────────────────────
// The shapes we read
// ─────────────────────────────────────────────────────────────────────────────

interface Section {
  label?: string;
  topic?: string;
  from: number;
  to: number;
  marksEach: number;
  type: string;
}

interface Paper {
  slug: string;
  class: number;
  subject: string;
  session: string;
  questionCount: number;
  paperFile?: string;
  schemeFile?: string;
  sections?: Section[];
  sectionsDerived?: boolean;
}

interface PaperFile {
  generatedAt?: string;
  papers: Paper[];
}

interface SyllabusUnit {
  name: string;
  bookCode?: string;
  chapters: number[];
}

interface SyllabusSubject {
  class: number;
  subject: string;
  units: SyllabusUnit[];
}

interface Syllabus {
  subjects: SyllabusSubject[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The shapes we write — data/rubrics.schema.md
// ─────────────────────────────────────────────────────────────────────────────

interface Concept {
  any: string[];
}

interface PlainStep {
  id: string;
  kind?: "step";
  marks: number;
  awardFor: string;
  keywords: Concept[];
  match?: "all" | "any";
}

interface ChooseOption {
  id: string;
  awardFor: string;
  keywords: Concept[];
}

interface ChooseStep {
  id: string;
  kind: "choose";
  chooseAtLeast: number;
  marksEach: number;
  awardFor: string;
  options: ChooseOption[];
}

interface DiagramStep {
  id: string;
  kind: "diagram";
  marks: number;
  awardFor: string;
  labels: string[];
  autoGradable: false;
}

type Step = PlainStep | ChooseStep | DiagramStep;

interface Rubric {
  id: string;
  paper: string;
  session: string;
  questionNo: number;
  variant?: string;
  variantsOffered?: string[];
  type: string;
  maxMarks: number;
  bookCode: string;
  chapter: number;
  class: number;
  subject: string;
  prompt?: string;
  ordering: "ordered" | "unordered";
  acceptEquivalentWording: boolean;
  scheme: { file: string; page: number; excerpt: string };
  markSplit: "printed" | "inferred";
  steps: Step[];
  needsReview: true;
  reviewNotes: string[];
}

interface Reject {
  paper: string;
  questionNo: number;
  variant?: string;
  maxMarks: number | null;
  type: string | null;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF text, laid out in lines and columns
//
// Every CBSE scheme and sample paper in public/papers/ is a three-column table:
// the question number on the left, the answer in the middle, the marks on the
// right. Flattening it to a string loses exactly the information the conversion
// needs, so the geometry is kept.
// ─────────────────────────────────────────────────────────────────────────────

interface Frag {
  x: number;
  w: number;
  s: string;
}

interface Line {
  page: number;
  y: number;
  /** Position in reading order across the whole document. */
  ord: number;
  frags: Frag[];
  text: string;
  x0: number;
  /** The line the question number sits on; the number is not part of the answer. */
  strip?: boolean;
  /** Running heads, section banners, folios — kept for their position only. */
  furniture?: boolean;
}

interface Doc {
  width: number;
  lines: Line[];
  /** Left edge of the marks column, or null if the document has no such column. */
  markColX: number | null;
}

/**
 * pdf.js splits a word wherever the font changes, so "than those" arrives as
 * "than th" + "ose" with a 0.4pt gap between them, while a real word break
 * arrives either as its own " " item or as a gap of several points. Joining on
 * the gap rather than unconditionally is what keeps "transpirational" out of
 * the keywords as "tra nspirational".
 */
const WORD_GAP = 1.0;

function joinFrags(frags: Frag[]): string {
  let out = "";
  let prevEnd: number | null = null;
  for (const f of frags) {
    if (prevEnd !== null && f.x - prevEnd > WORD_GAP) out += " ";
    out += f.s;
    prevEnd = f.x + f.w;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Running heads, section banners and folios: never part of an answer. */
const FURNITURE =
  /^(?:(?:page|pg)\s*\.?\s*\d+\s+of\s+\d+\b.*|section\s*[–—-]?\s*[a-e]\b.*|marking\s+scheme.*|class\s*[–—-]\s*x.*|\[this section comprises.*|general instructions?.*)$/i;

/**
 * A folio sitting alone in the margin at the top or bottom of a page. It is not
 * caught by wording — CBSE prints several as a bare "6" — so it is caught by
 * position. Left in, it lands in the scheme excerpt as if it were part of the
 * answer, and a bare number in the right margin can be read as a mark.
 */
const FOLIO = /^(?:(?:page|pg)\s*\.?\s*)?\d{1,3}$/i;

async function readDoc(pdfjs: Pdfjs, path: string): Promise<Doc> {
  const data = new Uint8Array(await readFile(path));
  const doc: PDFDocumentProxy = await pdfjs.getDocument({ data, ...FONT_OPTS }).promise;
  try {
    const lines: Line[] = [];
    let width = 0;
    let ord = 0;

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      width = Math.max(width, vp.width);
      const content = await page.getTextContent();

      // Cluster items into lines by baseline. Superscripts and stacked
      // fractions sit off the baseline by a few points, which is why this is a
      // tolerance rather than an equality.
      const buckets = new Map<number, Frag[]>();
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const it = item as TextItem;
        if (!it.str) continue;
        const y = Math.round(it.transform[5] / 3);
        const bucket = buckets.get(y) ?? [];
        bucket.push({ x: it.transform[4], w: it.width || 0, s: it.str });
        buckets.set(y, bucket);
      }

      const pageLines = [...buckets.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([y, frags]): Line => {
          frags.sort((a, b) => a.x - b.x);
          const solid = frags.filter((f) => f.s.trim());
          return {
            page: p,
            y: y * 3,
            ord: 0,
            frags,
            text: joinFrags(frags),
            x0: solid.length ? solid[0].x : Number.POSITIVE_INFINITY,
          };
        })
        .filter((l) => l.text);

      for (const l of pageLines) {
        l.ord = ord++;
        l.furniture =
          FURNITURE.test(l.text) ||
          (FOLIO.test(l.text) && (l.y < vp.height * 0.06 || l.y > vp.height * 0.95));
        lines.push(l);
      }
    }

    return { width, lines, markColX: markColumnOf(lines, width) };
  } finally {
    await doc.destroy();
  }
}

/** "1", "2", "½", "1½", "1 ½" — the whole vocabulary of CBSE's marks column. */
const MARK_TOKEN = /^(?:(\d{1,2})\s*(½)?|(½))$/;

function markValue(s: string): number | null {
  const m = MARK_TOKEN.exec(s.trim());
  if (!m) return null;
  const v = m[3] ? 0.5 : Number(m[1]) + (m[2] ? 0.5 : 0);
  // No question on any of these papers is worth more than 5; anything larger is
  // a folio or a quantity that happens to sit near the right margin.
  return v > 0 && v <= 5 ? v : null;
}

/** The rightmost solid fragment of a line, if it is separated from the prose. */
function tailFrag(line: Line): Frag | null {
  const solid = line.frags.filter((f) => f.s.trim());
  if (solid.length === 0) return null;
  const last = solid[solid.length - 1];
  if (solid.length === 1) return last;
  const prev = solid[solid.length - 2];
  return last.x - (prev.x + prev.w) > 4 ? last : null;
}

/**
 * Locate the marks column by agreement rather than by a fixed fraction of the
 * page: body text runs past 0.8 of the width in several schemes, so a band
 * alone would swallow prose. Candidates are mark-shaped fragments hanging off
 * the right end of their line; the column is where most of them agree.
 */
function markColumnOf(lines: Line[], width: number): number | null {
  const xs: number[] = [];
  for (const line of lines) {
    if (line.furniture) continue;
    const tail = tailFrag(line);
    if (!tail || tail.x < width * 0.7) continue;
    if (markValue(tail.s) === null) continue;
    xs.push(tail.x);
  }
  if (xs.length < 5) return null;
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}

interface MarkToken {
  ord: number;
  value: number;
}

function marksOn(line: Line, doc: Doc): MarkToken | null {
  if (doc.markColX === null) return null;
  const tail = tailFrag(line);
  if (!tail || Math.abs(tail.x - doc.markColX) > 15) return null;
  const v = markValue(tail.s);
  return v === null ? null : { ord: line.ord, value: v };
}

/** The line's prose, with the marks-column token and the question number removed. */
function proseOf(line: Line, doc: Doc): string {
  let text = line.text;
  if (marksOn(line, doc) !== null) {
    const solid = line.frags.filter((f) => f.s.trim());
    const drop = solid[solid.length - 1];
    text = joinFrags(line.frags.filter((f) => f !== drop));
  }
  return line.strip ? text.replace(ANCHOR, "").trim() : text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding the questions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A question number at the head of a line: "10", "1.", "Q.1", "21 (A).", "6B.".
 *
 * The letter that marks internal choice looks exactly like the letter that
 * marks an MCQ answer, and only the punctuation separates them. CBSE closes an
 * option label — "21 (A).", "6B." — and leaves an answer key open: "1) (b) x²y"
 * and "Q.1 C. P is not a base." are answers to question 1, not options of it.
 * So a variant letter must be closed by a stop, and a bare one must also sit
 * hard against the number.
 */
const ANCHOR = /^(?:Q\s*\.?\s*)?(\d{1,2})[.)]?(?:\s*\(\s*([A-Za-z])\s*\)\s*[.)]|([A-Za-z])\s*[.)])?(?=\s|$)/;

interface Anchor {
  questionNo: number;
  variant: string | null;
  line: Line;
}

/**
 * The numbered "General Instructions" every CBSE paper opens with sit in the
 * same left column as the question numbers and count 1, 2, 3 …, so a walker
 * looking for question 1 finds instruction 1 and then never recovers. The block
 * runs from the heading to the section banner that follows it, or to the end of
 * its page where the answers start overleaf.
 */
const INSTRUCTIONS = /^general\s+instructions?\b/i;
const SECTION_BANNER = /^section\b/i;

function instructionBlocks(lines: Line[]): { from: number; to: number }[] {
  const blocks: { from: number; to: number }[] = [];
  lines.forEach((line, i) => {
    if (!INSTRUCTIONS.test(line.text)) return;
    let to = line.ord;
    for (let j = i + 1; j < lines.length; j++) {
      if (SECTION_BANNER.test(lines[j].text)) break;
      if (lines[j].page !== line.page) break;
      to = lines[j].ord;
    }
    blocks.push({ from: line.ord, to });
  });
  return blocks;
}

/**
 * How far into the page a question number may sit. CBSE's own left margin moves
 * between sessions — 0.07 of the width in the 2025-26 Maths scheme, 0.21 in the
 * 2022-23 practice answer key — so the band is chosen by which one anchors the
 * most of the paper rather than fixed in advance.
 */
const LEFT_BANDS = [0.1, 0.14, 0.18, 0.22, 0.26, 0.32];

/**
 * Walk the document taking only the question numbers that continue the paper's
 * own sequence, the way extract-titles.ts trusts only a consecutive run on a
 * Contents page. A stray "3" in the middle of an answer does not start
 * question 3 if question 12 has already started.
 */
function walkAnchors(
  doc: Doc,
  questionCount: number,
  band: number,
  blocks: { from: number; to: number }[],
): Anchor[] {
  const found: Anchor[] = [];
  let expected = 1;
  let current = 0;

  for (const line of doc.lines) {
    if (line.furniture) continue;
    if (blocks.some((b) => line.ord >= b.from && line.ord <= b.to)) continue;
    if (line.x0 > doc.width * band) continue;
    const m = ANCHOR.exec(line.text);
    if (!m) continue;
    const n = Number(m[1]);
    const variant = (m[2] ?? m[3])?.toUpperCase() ?? null;

    if (n === expected && n <= questionCount) {
      found.push({ questionNo: n, variant, line });
      current = n;
      expected = n + 1;
    } else if (n === current && variant && found[found.length - 1]?.variant !== variant) {
      // "21 (A)." … "21 (B)." — CBSE's own labelling of internal choice.
      found.push({ questionNo: n, variant, line });
    }
  }
  return found;
}

function anchorsOf(doc: Doc, questionCount: number): Anchor[] {
  const blocks = instructionBlocks(doc.lines);
  let best: Anchor[] = [];
  for (const band of LEFT_BANDS) {
    const found = walkAnchors(doc, questionCount, band, blocks);
    if (found.length > best.length) best = found;
  }
  return best;
}

interface QuestionBody {
  questionNo: number;
  /** Non-null only where CBSE itself labelled the alternatives. */
  labelledVariant: string | null;
  page: number;
  lines: Line[];
  /** True where an alternative for visually impaired candidates was dropped. */
  droppedVIBlock: boolean;
}

const VI_BLOCK = /visually\s+(?:impaired|challenged)|\bV\.?\s?I\.?\s+candidates?\b/i;

function bodiesOf(doc: Doc, questionCount: number): QuestionBody[] {
  const anchors = anchorsOf(doc, questionCount);
  const out: QuestionBody[] = [];

  anchors.forEach((anchor, i) => {
    const from = anchor.line.ord;
    const to = i + 1 < anchors.length ? anchors[i + 1].line.ord : Number.POSITIVE_INFINITY;
    let lines = doc.lines.filter((l) => l.ord >= from && l.ord < to && !l.furniture);

    // CBSE reprints several questions in an alternative form for visually
    // impaired candidates, with its own marks. Left in, those marks double the
    // question's total and every sum check fails; they are a parallel paper,
    // not extra steps.
    const vi = lines.findIndex((l) => VI_BLOCK.test(l.text));
    const droppedVIBlock = vi >= 0;
    if (vi >= 0) lines = lines.slice(0, vi);

    // The question number is not part of the answer. Flagging the line rather
    // than dropping its leading fragments matters: in the sample papers the
    // prose column starts 2pt to the left of the anchor band, so a positional
    // cut takes the stem with it.
    if (lines.length) {
      const first = lines[0];
      lines = [{ ...first, text: first.text.replace(ANCHOR, "").trim(), strip: true }, ...lines.slice(1)];
    }

    out.push({
      questionNo: anchor.questionNo,
      labelledVariant: anchor.variant,
      page: anchor.line.page,
      lines: lines.filter((l) => l.text.trim()),
      droppedVIBlock,
    });
  });

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal choice — "Q34 (A) or Q34 (B)"
//
// Isolated on purpose. data/rubrics.schema.md currently models internal choice
// as a `variant` string on two otherwise separate rubrics, each summing to
// maxMarks on its own, and that is all this section knows. If the schema grows
// a richer model, this is the only place that has to change.
// ─────────────────────────────────────────────────────────────────────────────

/** A standalone "OR" between two alternatives, not the word inside a sentence. */
const OR_LINE = /^O\s*R$/i;
/** CBSE's own sentence announcing internal choice, printed above the split. */
const CHOICE_INTRO = /students?\s+to\s+attempt\s+either\s+(?:option|subpart)\s+[ab]\s+or\s+[ab]/i;

interface Alternative {
  variant: string | null;
  lines: Line[];
}

/**
 * Split a question body on a standalone "OR".
 *
 * The split is only *trusted* when it can be checked, and there are two ways to
 * check it: CBSE announced the choice in words, or each side carries its own
 * marks column adding to the question's total. An "OR" that passes neither test
 * is an alternative *answer* rather than an alternative *question* — the
 * 2015-16 Science scheme offers "or any other definition" this way — and the
 * caller refuses the question rather than inventing two rubrics from one.
 */
function alternativesOf(
  body: QuestionBody,
  doc: Doc,
  maxMarks: number,
): { alternatives: Alternative[]; trusted: boolean } {
  const announced = body.lines.some((l) => CHOICE_INTRO.test(l.text));
  const cuts = body.lines.map((l, i) => (OR_LINE.test(l.text) ? i : -1)).filter((i) => i >= 0);

  if (cuts.length === 0) {
    return { alternatives: [{ variant: body.labelledVariant, lines: body.lines }], trusted: true };
  }

  const segments: Line[][] = [];
  let start = 0;
  for (const cut of [...cuts, body.lines.length]) {
    segments.push(body.lines.slice(start, cut));
    start = cut + 1;
  }

  const letters = ["A", "B", "C", "D"];
  const alternatives = segments.map((lines, i) => ({
    variant: letters[i] ?? String(i + 1),
    // Drop CBSE's announcement line; it is instruction, not answer.
    lines: lines.filter((l) => !CHOICE_INTRO.test(l.text)),
  }));

  const eachSums = alternatives.every(
    (alt) => alt.lines.reduce((n, l) => n + (marksOn(l, doc)?.value ?? 0), 0) === maxMarks,
  );

  return { alternatives, trusted: announced || eachSums };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary: what counts as a keyword
// ─────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "about above after again against also although always among another answer answers any are because been " +
    "before being below between both but came can cannot come correct could describe difference different does " +
    "doing done down draw during each either else even ever every example explain few figure first following for " +
    "found from further gave give given gives goes going hence here high how however into its itself just keep " +
    "kept know known large last later least less let like little long made make makes many marks may more most " +
    "much must name namely near need next none nor not note now number often once only other others otherwise our " +
    "out over own part place point points question questions rather really same say see seen shall should show " +
    "shown since small some somewhat state still such take taken than that the their them then there these they " +
    "thing things this those though through thus together too towards under until upon use used uses using very " +
    "was way well went were what when where whether which while who whom whose why will with within without would " +
    "write written year years your marking scheme class section option options student students attempt answer"
  ).split(/\s+/),
);

/** Content words the corpus and the schemes share: 4+ letters, not furniture. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 4 && t.length <= 24 && !STOPWORDS.has(t));
}

// ─────────────────────────────────────────────────────────────────────────────
// Chapter attribution, from the mirrored NCERT textbooks
// ─────────────────────────────────────────────────────────────────────────────

interface ChapterProfile {
  bookCode: string;
  chapter: number;
  title: string;
  /** L2-normalised tf-idf weights, keyed by term. */
  weights: Map<string, number>;
}

interface SubjectIndex {
  chapters: ChapterProfile[];
  idf: Map<string, number>;
}

/**
 * Top match plus how far ahead it is. A question whose best chapter is barely
 * ahead of the next one has not been attributed, it has been guessed, and the
 * caller refuses it.
 */
const CHAPTER_MIN_SCORE = 0.05;
const CHAPTER_MIN_MARGIN = 1.25;

async function buildSubjectIndex(
  pdfjs: Pdfjs,
  manifest: Manifest,
  bookCodes: string[],
): Promise<SubjectIndex> {
  const raw: { bookCode: string; chapter: number; title: string; tf: Map<string, number> }[] = [];

  for (const code of bookCodes) {
    const book = manifest.books.find((b) => b.code === code);
    if (!book) continue;
    for (const ch of book.chapters) {
      const path = `${NCERT_DIR}/${code}/${ch.file}`;
      if (!existsSync(path)) continue;
      const data = new Uint8Array(await readFile(path));
      const doc: PDFDocumentProxy = await pdfjs.getDocument({ data, ...FONT_OPTS }).promise;
      const tf = new Map<string, number>();
      try {
        for (let p = 1; p <= doc.numPages; p++) {
          const content = await doc.getPage(p).then((pg) => pg.getTextContent());
          const text = content.items.map((i) => ("str" in i ? (i as TextItem).str : "")).join(" ");
          for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
        }
      } finally {
        await doc.destroy();
      }
      // The title is the one piece of the chapter a question is most likely to
      // echo, so it counts for more than a passing mention in the body.
      for (const t of tokenize(ch.title)) tf.set(t, (tf.get(t) ?? 0) + 25);
      raw.push({ bookCode: code, chapter: ch.n, title: ch.title, tf });
    }
  }

  const df = new Map<string, number>();
  for (const r of raw) for (const t of r.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);

  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + raw.length / n));

  const chapters = raw.map((r) => {
    const weights = new Map<string, number>();
    let norm = 0;
    for (const [t, n] of r.tf) {
      const w = (1 + Math.log(n)) * (idf.get(t) ?? 0);
      if (w <= 0) continue;
      weights.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of weights) weights.set(t, w / norm);
    return { bookCode: r.bookCode, chapter: r.chapter, title: r.title, weights };
  });

  return { chapters, idf };
}

interface Attribution {
  bookCode: string;
  chapter: number;
  title: string;
  score: number;
  margin: number;
  runnerUp: string;
}

function attributeChapter(index: SubjectIndex, text: string): Attribution | null {
  const tf = new Map<string, number>();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  if (tf.size === 0) return null;

  const query = new Map<string, number>();
  let norm = 0;
  for (const [t, n] of tf) {
    const w = (1 + Math.log(n)) * (index.idf.get(t) ?? 0);
    if (w <= 0) continue;
    query.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return null;

  const scored = index.chapters
    .map((c) => {
      let s = 0;
      for (const [t, w] of query) s += (c.weights.get(t) ?? 0) * w;
      return { c, s: s / norm };
    })
    .sort((a, b) => b.s - a.s || a.c.chapter - b.c.chapter);

  if (scored.length === 0 || scored[0].s < CHAPTER_MIN_SCORE) return null;
  const best = scored[0];
  const next = scored[1];
  const margin = next && next.s > 0 ? best.s / next.s : Number.POSITIVE_INFINITY;
  if (margin < CHAPTER_MIN_MARGIN) return null;

  return {
    bookCode: best.c.bookCode,
    chapter: best.c.chapter,
    title: best.c.title,
    score: best.s,
    margin,
    runnerUp: next ? `${next.c.bookCode}:${next.c.chapter} ${next.c.title}` : "—",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheme prose → steps
// ─────────────────────────────────────────────────────────────────────────────

const ENUM_MARKER =
  /^(?:[●•▪◦*-]|\(?(?:[ivx]{1,4}|[a-h]|\d{1,2})\)|(?:[ivx]{1,4}|[a-h]|\d{1,2})\.)\s+/i;

/** "(any two)", "Any 2 points", "Any one to be considered". */
const ANY_N = /\bany\s+(one|two|three|four|five|six|\d{1,2})\b(?!\s+other)/i;

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function anyCount(text: string): number | null {
  const m = ANY_N.exec(text);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const n = WORD_NUMBERS[raw] ?? Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

const isHalfStep = (marks: number) => marks * 2 === Math.round(marks * 2) && marks > 0;

/** Text with enumeration markers, mark tokens and stray punctuation removed. */
function cleanProse(lines: string[]): string {
  return lines
    .map((l) => l.replace(ENUM_MARKER, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A short human-readable label for a step or option. */
function awardLabel(prose: string, limit = 150): string {
  const s = prose.replace(/\s+/g, " ").trim();
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf(" "), 0);
  return `${cut.slice(0, stop || limit)}…`;
}

/**
 * One concept holding the step's most distinctive terms.
 *
 * Not several concepts: with the schema's default `match: "all"` a multi-concept
 * step demands every one of them, and a demand assembled by a script is a
 * demand nobody has checked. One concept means "the answer used any of the
 * scheme's own distinctive words here", which is the weakest honest claim this
 * script can make — and a draft rubric may not paint red anyway.
 *
 * Terms must exist in the subject's textbooks: it keeps extraction noise and
 * stray glyphs out of a file a teacher has to read.
 */
const KEYWORDS_PER_STEP = 6;

function conceptFor(prose: string, index: SubjectIndex): Concept | null {
  const tokens = tokenize(prose);
  if (tokens.length === 0) return null;

  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  const scored = [...tf.entries()]
    .filter(([t]) => index.idf.has(t))
    .map(([t, n]) => ({ t, w: (1 + Math.log(n)) * (index.idf.get(t) ?? 0) }))
    .sort((a, b) => b.w - a.w || a.t.localeCompare(b.t));
  if (scored.length === 0) return null;

  const chosen = scored.slice(0, KEYWORDS_PER_STEP).map((s) => s.t);
  const keep = new Set(chosen);

  // A pair of adjacent distinctive words is a better keyword than either alone
  // ("cell body", "modal class"), so add the bigrams the step actually contains.
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (keep.has(tokens[i]) && keep.has(tokens[i + 1])) {
      const bg = `${tokens[i]} ${tokens[i + 1]}`;
      if (!bigrams.includes(bg)) bigrams.push(bg);
    }
  }

  const any = [...chosen, ...bigrams.slice(0, 2)];
  return any.length ? { any } : null;
}

/**
 * CBSE pays for figures; a keyword matcher cannot read one.
 *
 * The first alternative is scripts/check-rubrics.mjs's own FIGURE_MARK, copied
 * deliberately: the validator *fails* a rubric whose `scheme.excerpt` prints a
 * figure mark and whose steps contain no `diagram`, so the two must agree about
 * what a printed figure mark looks like or this script would emit rubrics its
 * own gate would reject.
 */
const FIGURE_MARK = /\bfor\s+(?:the\s+|a\s+)?correct\s+(?:figure|diagram)|\bfor\s+(?:the\s+|a\s+)?(?:figure|diagram)\b/i;
const DIAGRAM_STEP =
  /\b(?:correct\s+(?:figure|diagram|construction|graph)|labelled\s+diagram|neat\s+diagram|drawing\s+the\s+figure)\b/i;

/**
 * A step that is a pointer to a drawing rather than a sentence: the 2016-17
 * Science scheme pays two of its five marks for ray diagrams and writes them
 * "For glass slab refer:" / "For prism refer:", with the figures alongside.
 * Read as prose those become steps a student satisfies by writing the word
 * "slab"; read as diagrams they are left unmarked for a human, which is the
 * safe reading of a mark this script cannot check.
 */
const FIGURE_REFERENCE = /\b(refer|as shown|see fig|fig\.?\s*[a-z0-9]?)\b/i;

const isDiagramText = (s: string) =>
  FIGURE_MARK.test(s) || DIAGRAM_STEP.test(s) || (s.length < 60 && FIGURE_REFERENCE.test(s));

/**
 * Words in a stem that ask for something drawn — check-rubrics.mjs's DRAW_STEM,
 * copied again. It warns where a stem asks for a drawing and no step is a
 * diagram, and asks the author to say in reviewNotes why the scheme gives no
 * figure mark. Saying so is this script's job, not the reviewer's.
 */
const DRAW_STEM = /\b(draw|draws|redraw|sketch|diagram|diagrams|figure|labell?ed|labell?ing|label|plot|construct)\b/i;

/**
 * The two patterns check-rubrics.mjs reads a `scheme.excerpt` with, copied for
 * the same reason. A rubric whose excerpt offers an alternative it does not
 * model is a hard error there, so it is a refusal here.
 */
const EXCERPT_OR_ALONE = /(^|\n)[\s.)\]]*OR[\s.:(]*(\n|$)/;
const EXCERPT_OR_HEADER =
  /\b(attempt either|either option [A-Z]\b|either sub-?part [A-Z]\b|either [A-Z] or [A-Z]\b|internal choice)/i;

/** The scheme's answer column for one question, line for line, capped. */
const EXCERPT_LIMIT = 1400;

function excerptOf(lines: string[]): string {
  const kept: string[] = [];
  let n = 0;
  for (const line of lines) {
    if (n + line.length > EXCERPT_LIMIT && kept.length) {
      kept.push("…");
      break;
    }
    kept.push(line);
    n += line.length + 1;
  }
  return kept.join("\n").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion
// ─────────────────────────────────────────────────────────────────────────────

const OBJECTIVE_ANSWER = /(?:^|\b)ans(?:wer)?\s*(?:key)?\s*[–—:-]?\s*\(?([A-D])\)?(?:\b|$)/i;
/** "(b) x²y", "b) 70°", "C. Cuscuta…" — CBSE has used all three. */
const LEADING_OPTION = /^\(?\s*([A-D])\s*(?:\)|\.|:)\s*(.*)$/i;
/** An answer-key table prints the letter and nothing else. */
const BARE_OPTION = /^\(?\s*([A-D])\s*\)?\s*[.:]?$/i;

interface Conversion {
  steps: Step[];
  notes: string[];
  ordering: "ordered" | "unordered";
  acceptEquivalentWording: boolean;
  /** Whether CBSE printed this split in the margin, or this script inferred it. */
  markSplit: "printed" | "inferred";
}

/**
 * mcq and assertion-reason, 1 mark. The scheme states the option, so the rubric
 * is exact by construction: one step, worth the whole mark, matched on the
 * letter the student writes or on the option's own wording.
 */
function convertObjective(alt: Alternative, doc: Doc, maxMarks: number): Conversion | string {
  // Not cleanProse: it strips enumeration markers, and "C." *is* the answer here.
  const prose = alt.lines
    .map((l) => proseOf(l, doc))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const answer = OBJECTIVE_ANSWER.exec(prose);
  const leading = LEADING_OPTION.exec(prose);
  const bare = BARE_OPTION.exec(prose);
  const letter = (answer?.[1] ?? leading?.[1] ?? bare?.[1])?.toUpperCase();
  if (!letter) return "the scheme states no option letter, so there is nothing to mark against";

  const rest = (leading?.[2] ?? prose.replace(OBJECTIVE_ANSWER, "")).trim();
  // An answer-key table prints the letter and nothing else, and "selects option
  // B - B" reads as though something was lost.
  const wording = BARE_OPTION.test(rest) ? "" : awardLabel(rest.replace(/^[.,;:–—-]\s*/, ""), 110);

  const any = [letter, `(${letter})`, `${letter}.`, `option ${letter}`];
  if (wording && /[a-z]{4}/i.test(wording)) any.push(wording.toLowerCase());

  return {
    steps: [
      {
        id: "s1",
        marks: maxMarks,
        awardFor: wording ? `selects option ${letter} — ${awardLabel(wording, 110)}` : `selects option ${letter}`,
        keywords: [{ any }],
      },
    ],
    notes: [
      `The scheme gives option ${letter}. The step matches the bare letter as well as the option's wording; confirm the letter alone is what the paper asks the student to write.`,
    ],
    ordering: "unordered",
    // The answer is one specific option. A near miss is a different option.
    acceptEquivalentWording: false,
    // The scheme prints the mark for this question and the step takes all of it.
    markSplit: "printed",
  };
}

/**
 * The scheme's own per-step split: every token in the marks column becomes one
 * step, covering the prose above it. Emitted only when the tokens sum to the
 * marks data/papers.json allots the question.
 */
function convertSplit(
  alt: Alternative,
  doc: Doc,
  maxMarks: number,
  index: SubjectIndex,
  subject: string,
): Conversion | string {
  const tokens: { ord: number; value: number }[] = [];
  for (const line of alt.lines) {
    const t = marksOn(line, doc);
    if (t) tokens.push(t);
  }
  if (tokens.length === 0) return "the scheme prints no marks against this question";

  const sum = tokens.reduce((n, t) => n + t.value, 0);
  if (Math.round(sum * 2) !== Math.round(maxMarks * 2)) {
    return `the scheme's marks column reads ${tokens.map((t) => t.value).join(" + ")} = ${sum} but the paper allots ${maxMarks}`;
  }
  if (tokens.length === 1) {
    return `the scheme prints one total of ${maxMarks} and no per-step split`;
  }

  const steps: Step[] = [];
  let prev = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const prose = cleanProse(
      alt.lines.filter((l) => l.ord > prev && l.ord <= token.ord).map((l) => proseOf(l, doc)),
    );
    prev = token.ord;
    if (!isHalfStep(token.value)) return `the marks column reads ${token.value}, which is not a multiple of ½`;

    const label = awardLabel(prose);
    if (isDiagramText(prose)) {
      steps.push({
        id: `s${i + 1}`,
        kind: "diagram",
        marks: token.value,
        awardFor: label || "a correct figure",
        labels: tokenize(prose).slice(0, 6),
        autoGradable: false,
      });
      continue;
    }

    const concept = conceptFor(prose, index);
    if (!concept) {
      return `step ${i + 1} of the scheme is working with no words in it (${JSON.stringify(awardLabel(prose, 60))}), so no keyword could be lifted from it`;
    }
    steps.push({ id: `s${i + 1}`, marks: token.value, awardFor: label, keywords: [concept] });
  }

  return {
    steps,
    notes: [
      `Steps and their marks are the scheme's own marks column (${tokens.map((t) => t.value).join(" + ")} = ${maxMarks}); the wording of each step is the scheme text printed against that mark.`,
      "Keywords are the most distinctive terms of the scheme's own wording for each step, held as one concept, so any one of them satisfies the step. Split them into real concepts before signing this off.",
    ],
    // Maths working is ordered — the discriminant before the roots. Recall is not.
    ordering: subject.startsWith("Mathematics") ? "ordered" : "unordered",
    acceptEquivalentWording: true,
    markSplit: "printed",
  };
}

/**
 * "Any two of the following", over a list the scheme enumerates. The only shape
 * whose arithmetic CBSE supplies without a per-step split, and the shape the
 * hand-authored Social Science rubrics are almost entirely made of.
 */
function convertChoose(
  alt: Alternative,
  doc: Doc,
  maxMarks: number,
  index: SubjectIndex,
): Conversion | string {
  const prose = alt.lines.map((l) => proseOf(l, doc));
  const markerIndex = prose.findIndex((l) => anyCount(l) !== null);
  if (markerIndex < 0) return "the scheme does not say 'any N of the following'";
  const n = anyCount(prose[markerIndex]);
  if (n === null) return "the scheme does not say 'any N of the following'";

  // "Any one ..." is not this shape. CBSE writes it inside a sub-part -- "(ANY
  // ONE POINT)" under 36.1 of the 2022-23 Social Science scheme, "(any one
  // function each of Medulla and Cerebellum)" inside part (a) of Science
  // 2017-18 Q18 -- and this path builds one group for the whole question, so
  // reading it as "any one of these earns all 5 marks" pays the whole question
  // for a fragment of it. Both of those shipped in an earlier run of this
  // script. A group that carries a whole rubric has to be a list the scheme
  // asks for two or more of.
  if (n < 2) {
    return `the scheme says "any ${n}", which in CBSE's usage marks a sub-part rather than the whole answer; splitting the question on it would pay every mark for one point`;
  }

  const marksEach = maxMarks / n;
  if (!isHalfStep(marksEach)) {
    return `the scheme asks for any ${n} of a list but ${maxMarks} marks does not divide into ${n} whole halves`;
  }

  // Options are the enumerated block after the marker.
  const groups: string[][] = [];
  for (let i = markerIndex; i < alt.lines.length; i++) {
    const text = prose[i];
    if (ENUM_MARKER.test(text)) groups.push([text]);
    else if (groups.length) groups[groups.length - 1].push(text);
  }
  if (groups.length < n) {
    return `the scheme asks for any ${n} but only ${groups.length} enumerated option(s) could be read from it`;
  }

  const options: ChooseOption[] = [];
  groups.forEach((g, i) => {
    const text = cleanProse(g);
    const concept = conceptFor(text, index);
    if (!concept) return;
    options.push({ id: `o${i + 1}`, awardFor: awardLabel(text), keywords: [concept] });
  });
  if (options.length < n) {
    return `the scheme asks for any ${n} but only ${options.length} of its options carried words a keyword could be lifted from`;
  }

  const preamble = cleanProse(prose.slice(0, markerIndex));

  return {
    steps: [
      {
        id: "g1",
        kind: "choose",
        chooseAtLeast: n,
        marksEach,
        awardFor: awardLabel(prose[markerIndex] || `any ${n} of the scheme's list`, 120),
        options,
      },
    ],
    notes: [
      `The scheme prints one total of ${maxMarks} and asks for any ${n} of a list of ${options.length}; the ${n} × ${marksEach} split is inferred from that, not printed.`,
      ...(preamble
        ? [
            `The scheme's opening text (${JSON.stringify(awardLabel(preamble, 90))}) earns no mark under this rubric — a student who writes only that scores zero. Confirm that is intended.`,
          ]
        : []),
      "Keywords are the most distinctive terms of each listed option, held as one concept, so any one of them satisfies that option.",
    ],
    ordering: "unordered",
    acceptEquivalentWording: true,
    // CBSE printed one total and the count; the per-option marks are this
    // script's arithmetic on those two numbers, not a figure from the margin.
    markSplit: "inferred",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────────────────────────

const SUBJECT_ALIASES: Record<string, string> = {
  "Mathematics (Basic)": "Mathematics",
  "Mathematics (Standard)": "Mathematics",
};

function syllabusSubject(paper: Paper): string {
  return SUBJECT_ALIASES[paper.subject] ?? paper.subject;
}

function booksFor(syllabus: Syllabus, paper: Paper): string[] {
  const name = syllabusSubject(paper);
  const entry = syllabus.subjects.find((s) => s.class === paper.class && s.subject === name);
  if (!entry) return [];
  return [...new Set(entry.units.map((u) => u.bookCode).filter((c): c is string => !!c))];
}

function sectionFor(paper: Paper, questionNo: number): Section | undefined {
  return (paper.sections ?? []).find((s) => questionNo >= s.from && questionNo <= s.to);
}

interface Args {
  paper?: string;
  explain?: { slug: string; questionNo: number };
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--paper" && argv[i + 1]) args.paper = argv[++i];
    else if (argv[i] === "--explain" && argv[i + 1]) {
      const [slug, q] = argv[++i].split(":");
      if (slug && q && Number.isFinite(Number(q))) args.explain = { slug, questionNo: Number(q) };
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const paperFile = JSON.parse(await readFile(PAPERS_JSON, "utf8")) as PaperFile;
  const manifest = JSON.parse(await readFile(MANIFEST_JSON, "utf8")) as Manifest;
  const syllabus = JSON.parse(await readFile(SYLLABUS_JSON, "utf8")) as Syllabus;

  // Read-only: the hand-authored file is Lane H's, and a question a human has
  // already converted must not be drafted over.
  const authored = new Set<string>();
  if (existsSync(RUBRICS_JSON)) {
    const existing = JSON.parse(await readFile(RUBRICS_JSON, "utf8")) as { rubrics?: Rubric[] };
    for (const r of existing.rubrics ?? []) {
      authored.add(`${r.paper}#${r.questionNo}${r.variant ? `/${r.variant}` : ""}`);
      authored.add(`${r.paper}#${r.questionNo}`);
    }
  }

  const targets = paperFile.papers.filter((p) => {
    if (args.paper && p.slug !== args.paper) return false;
    if (args.explain && p.slug !== args.explain.slug) return false;
    if (p.sectionsDerived === false || !(p.sections ?? []).length) return false;
    return !!p.schemeFile && existsSync(`${PAPER_DIR}/${p.schemeFile}`);
  });

  if (targets.length === 0) {
    console.error(
      "No paper to process. Only papers with sectionsDerived !== false have a mark grid a rubric can be checked against.",
    );
    process.exit(1);
  }

  const explaining = args.explain;
  const rubrics: Rubric[] = [];
  const rejects: Reject[] = [];
  const indexCache = new Map<string, SubjectIndex>();
  let processed = 0;
  let skipped = 0;

  for (const paper of targets) {
    const bookCodes = booksFor(syllabus, paper);
    if (bookCodes.length === 0) {
      console.log(`[${paper.slug}] no NCERT book maps to "${paper.subject}" in ${SYLLABUS_JSON}; skipped`);
      continue;
    }

    const key = bookCodes.join(",");
    let index = indexCache.get(key);
    if (!index) {
      process.stdout.write(`  indexing ${key} … `);
      index = await buildSubjectIndex(pdfjs, manifest, bookCodes);
      indexCache.set(key, index);
      console.log(`${index.chapters.length} chapters, ${index.idf.size} terms`);
    }

    const scheme = await readDoc(pdfjs, `${PAPER_DIR}/${paper.schemeFile}`);
    const bodies = bodiesOf(scheme, paper.questionCount);

    // The paper itself supplies the stem: a prompt for the reviewer, and more
    // words for the chapter attribution than a terse scheme line carries.
    const stems = new Map<number, string>();
    if (paper.paperFile && existsSync(`${PAPER_DIR}/${paper.paperFile}`)) {
      const sqp = await readDoc(pdfjs, `${PAPER_DIR}/${paper.paperFile}`);
      for (const body of bodiesOf(sqp, paper.questionCount)) {
        const text = cleanProse(body.lines.map((l) => proseOf(l, sqp)));
        if (text && !stems.has(body.questionNo)) stems.set(body.questionNo, text);
      }
    }

    console.log(
      `[${paper.slug}] ${bodies.length}/${paper.questionCount} questions anchored in ${paper.schemeFile}`,
    );

    for (const body of bodies) {
      if (explaining && body.questionNo !== explaining.questionNo) continue;

      const section = sectionFor(paper, body.questionNo);
      const reject = (reason: string, variant?: string) => {
        rejects.push({
          paper: paper.slug,
          questionNo: body.questionNo,
          ...(variant ? { variant } : {}),
          maxMarks: section?.marksEach ?? null,
          type: section?.type ?? null,
          reason,
        });
        if (explaining) console.log(`  x Q${body.questionNo}${variant ? ` (${variant})` : ""}: ${reason}`);
      };

      if (!section) {
        processed++;
        reject("no section in data/papers.json covers this question, so it has no mark total to check against");
        continue;
      }
      if (authored.has(`${paper.slug}#${body.questionNo}`)) {
        skipped++;
        if (explaining) console.log(`  – Q${body.questionNo}: already hand-authored in ${RUBRICS_JSON}`);
        continue;
      }
      processed++;

      const maxMarks = section.marksEach;
      const { alternatives, trusted } = alternativesOf(body, scheme, maxMarks);
      if (!trusted) {
        reject(
          "the scheme carries a standalone 'OR' that is neither announced as internal choice nor balanced in the marks column, so its scope could not be determined",
        );
        continue;
      }

      const stem = stems.get(body.questionNo) ?? "";
      // Every option the paper prints here, so a half-covered choice is visible
      // rather than silent: one option refused and the other emitted would
      // otherwise read as a fully graded question.
      const offered = [
        ...new Set(
          [
            ...bodies.filter((b) => b.questionNo === body.questionNo).map((b) => b.labelledVariant),
            ...(alternatives.length > 1 ? alternatives.map((a) => a.variant) : []),
          ].filter((v): v is string => !!v),
        ),
      ].sort();

      for (const alt of alternatives) {
        const variant = alternatives.length > 1 ? (alt.variant ?? undefined) : (body.labelledVariant ?? undefined);
        if (variant && authored.has(`${paper.slug}#${body.questionNo}/${variant}`)) {
          skipped++;
          continue;
        }

        const schemeLines = alt.lines.map((l) => proseOf(l, scheme)).filter((t) => t.trim());
        const schemeProse = cleanProse(schemeLines);
        if (!schemeProse) {
          reject("the scheme prints nothing readable for this question", variant);
          continue;
        }

        // The excerpt is what lets rubric:check read the scheme rather than
        // only the conversion — and it turns two of its warnings into hard
        // errors, so both are checked here first, against the whole scheme text
        // rather than the truncated excerpt. A rubric this script would emit and
        // the validator would reject is a rubric this script must refuse.
        const excerpt = excerptOf(schemeLines);
        const wholeText = schemeLines.join("\n");
        if (!variant && (EXCERPT_OR_ALONE.test(wholeText) || EXCERPT_OR_HEADER.test(wholeText))) {
          reject(
            "the scheme offers an alternative here that this script could not model as a variant; per data/rubrics.schema.md it needs a kind:\"alternatives\" step, which only a human can size because CBSE prints no marks for the branches",
            variant,
          );
          continue;
        }

        const objective = section.type === "mcq" || section.type === "assertion-reason";
        const attempts: { how: string; run: () => Conversion | string }[] = objective
          ? [{ how: "objective", run: () => convertObjective(alt, scheme, maxMarks) }]
          : [
              { how: "marks column", run: () => convertSplit(alt, scheme, maxMarks, index, paper.subject) },
              { how: "any-N list", run: () => convertChoose(alt, scheme, maxMarks, index) },
            ];

        let converted: Conversion | null = null;
        const failures: string[] = [];
        for (const attempt of attempts) {
          const result = attempt.run();
          if (typeof result === "string") failures.push(`${attempt.how}: ${result}`);
          else {
            converted = result;
            break;
          }
        }

        if (!converted) {
          reject(failures.join("; "), variant);
          continue;
        }

        if (FIGURE_MARK.test(wholeText) && !converted.steps.some((st) => st.kind === "diagram")) {
          reject(
            `the scheme prints a figure mark ("${(wholeText.match(FIGURE_MARK) ?? [""])[0].trim()}") that this conversion could not attach to a step of its own, so the mark CBSE pays for the drawing would be unpayable`,
            variant,
          );
          continue;
        }

        const attribution = attributeChapter(index, `${stem} ${schemeProse}`);
        if (!attribution) {
          reject(
            "the question's wording did not match any one chapter of the subject decisively enough to file it, and a rubric with no chapter has nowhere to send its result",
            variant,
          );
          continue;
        }

        const book = manifest.books.find((b) => b.code === attribution.bookCode);
        if (!book) {
          reject(`chapter attribution named book ${attribution.bookCode}, which is not in ${MANIFEST_JSON}`, variant);
          continue;
        }

        const id = `${paper.slug}-q${body.questionNo}${variant ? `-${variant.toLowerCase()}` : ""}`;
        const rubric: Rubric = {
          id,
          paper: paper.slug,
          session: paper.session,
          questionNo: body.questionNo,
          ...(variant ? { variant } : {}),
          ...(variant && offered.length > 1 ? { variantsOffered: offered } : {}),
          type: section.type,
          maxMarks,
          bookCode: book.code,
          chapter: attribution.chapter,
          class: book.class,
          subject: book.subject,
          ...(stem ? { prompt: awardLabel(stem, 300) } : {}),
          ordering: converted.ordering,
          acceptEquivalentWording: converted.acceptEquivalentWording,
          scheme: { file: paper.schemeFile as string, page: body.page, excerpt },
          markSplit: converted.markSplit,
          steps: converted.steps,
          needsReview: true,
          reviewNotes: [
            `Drafted mechanically by scripts/extract-rubrics.ts from ${paper.schemeFile}, page ${body.page}. No human has read it.`,
            ...converted.notes,
            `Chapter ${attribution.chapter} (${attribution.title}) of ${book.code} was inferred by matching this question's wording against the mirrored NCERT chapters — ${attribution.score.toFixed(3)} against ${attribution.margin === Number.POSITIVE_INFINITY ? "no" : attribution.margin.toFixed(2) + "× the"} runner-up ${attribution.runnerUp}. CBSE tags no chapter; check it.`,
            ...(DRAW_STEM.test(stem) && !converted.steps.some((st) => st.kind === "diagram")
              ? [
                  `The stem mentions something drawn ("${(stem.match(DRAW_STEM) ?? [""])[0]}") and this rubric has no diagram step, because the scheme's marks column prints no figure mark against this question. If the drawing is the student's to produce rather than the paper's to supply, a mark has to come out of the steps above and into a diagram step; a student who draws it correctly and writes nothing scores zero as this stands.`,
                ]
              : []),
            ...(body.droppedVIBlock
              ? [
                  "The scheme's alternative for visually impaired candidates was dropped before the marks were summed; it is a parallel question, not extra steps.",
                ]
              : []),
            ...(variant
              ? [
                  `This is option ${variant}${offered.length > 1 ? ` of ${offered.join(" / ")}` : ""} — an internal choice of the whole question. A student attempts one option; the grader must pick the variant the answer matches.`,
                ]
              : []),
          ],
        };

        rubrics.push(rubric);

        if (explaining) {
          console.log(`\n  ✓ ${id}`);
          console.log(`     scheme text: ${awardLabel(schemeProse, 400)}`);
          console.log(JSON.stringify(rubric, null, 2));
        }
      }
    }
  }

  if (explaining) return;

  rubrics.sort((a, b) => a.paper.localeCompare(b.paper) || a.questionNo - b.questionNo || (a.variant ?? "").localeCompare(b.variant ?? ""));
  rejects.sort((a, b) => a.paper.localeCompare(b.paper) || a.questionNo - b.questionNo || (a.variant ?? "").localeCompare(b.variant ?? ""));

  await writeFile(
    OUT,
    `${JSON.stringify(
      {
        generatedAt: paperFile.generatedAt ?? null,
        source:
          "Drafted by scripts/extract-rubrics.ts from the CBSE marking schemes in public/papers/, for the papers in data/papers.json whose mark grid is derived. Every rubric here is an unreviewed draft: needsReview is true on all of them, and a grader must not paint a missed step red on any of them. Nothing in this file has been read by a human. Move a rubric into data/rubrics.json only after a teacher has checked it against the scheme named in its `scheme` field.",
        rubrics,
        rejects,
      },
      null,
      2,
    )}\n`,
  );

  const byReason = new Map<string, number>();
  for (const r of rejects) {
    const head = r.reason.split(";")[0].split("(")[0].trim().slice(0, 90);
    byReason.set(head, (byReason.get(head) ?? 0) + 1);
  }

  console.log(
    `\n${processed} question(s) processed, ${skipped} already hand-authored, ${rubrics.length} draft rubric(s), ${rejects.length} refused.`,
  );
  console.log("\nTop reasons for refusal:");
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }

  const byType = new Map<string, number>();
  for (const r of rubrics) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  console.log("\nBy question type:");
  for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${type.padEnd(18)} ${n}`);

  const bySubject = new Map<string, number>();
  for (const r of rubrics) bySubject.set(r.subject, (bySubject.get(r.subject) ?? 0) + 1);
  console.log("\nBy subject:");
  for (const [s, n] of [...bySubject].sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(18)} ${n}`);

  console.log(`\nWrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
