/**
 * Phase 0, step 4 — recover chapter titles.
 *
 * NCERT labels every chapter generically ("Chapter 1") and publishes titles
 * nowhere on its site, so they have to be recovered from the PDFs. Four
 * sources are tried in order of reliability:
 *
 *   0. data/title-overrides.json — hand-curated, always wins.
 *   1. The Contents page in the book's prelims PDF (`<code>ps.pdf`).
 *   2. The running header on the chapter's own early pages.
 *   3. The largest type on the chapter's first page.
 *
 * Anything still unresolved keeps the "Chapter N" label, which is exactly what
 * ncert.nic.in itself shows — never a mangled guess.
 *
 * Known limit: the Class 9 and 10 Hindi titles are typeset in a legacy 8-bit
 * Devanagari font, so extraction returns transliterated mojibake rather than
 * Unicode. Those books are the reason title-overrides.json exists.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { PDFDocumentProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { BASE, fetchWithRetry, sleep, type Manifest } from "./lib/ncert";

const FORCE = process.argv.includes("--force");
const PDF_ROOT = "public/ncert";
const PRELIMS_DIR = "data/prelims";
const OVERRIDES = "data/title-overrides.json";

/**
 * Several NCERT PDFs use legacy CID font encodings. Without pdf.js's cmap
 * tables and standard font data, extraction returns mojibake for them.
 */
const FONT_OPTS = {
  cMapUrl: "node_modules/pdfjs-dist/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  useSystemFonts: true,
} as const;

/** Back-matter headings that mark the end of the chapter list on a Contents page. */
const TAIL =
  /\b(Answers?|Appendix|Glossary|Index|Reprint|CONTENTS|Notes|Bibliography|Image Credits)\b/i;

/** Chapters are never hundreds of pages apart; used to reject in-title numbers. */
const MAX_PAGE_GAP = 200;

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

const isGeneric = (t: string) => /^Chapter \d+$/.test(t);

/**
 * Books whose titles are typeset in a legacy 8-bit Devanagari font. Text
 * extraction returns broken conjuncts or the author's name rather than the
 * chapter title, so extraction is skipped entirely and they keep the same
 * "Chapter N" labelling ncert.nic.in itself uses, until someone supplies real
 * titles through title-overrides.json. A wrong title is worse than a plain one.
 */
const NEEDS_CURATION = new Set(["ihga1", "jhkr1", "jhks1", "jhsp1", "jhsy1"]);

/**
 * NCERT sets headings in small caps, which extract with the large initial
 * split off: "R EAL N UMBERS", "J AMES H ERRIOT". Rejoin those, then convert a
 * fully upper-case result to title case.
 */
function normalise(input: string): string {
  let s = input.replace(/\s+/g, " ").trim();
  s = s.replace(/\b([A-Z]) (?=[A-Z]{2,}\b)/g, "$1");
  s = s.replace(/^(?:Chapter|Unit|Section)\s+([IVXLC]+|\d+)[.:\s]+/i, "").trim();

  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length > 2 && letters === letters.toUpperCase()) {
    const small = new Set(["a", "an", "the", "of", "and", "or", "in", "to", "for", "with", "its"]);
    s = s
      .toLowerCase()
      .split(" ")
      .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ");
  }
  return s.trim();
}

function acceptable(t: string): boolean {
  return t.length >= 3 && t.length <= 120 && /[A-Za-zऀ-ॿ]{3}/.test(t);
}

/**
 * Parse a Contents page into chapter -> title.
 *
 * Every entry ends with its page number, but titles contain numbers too
 * ("State and Society up to 1000 CE"). The page number is identified as the
 * first standalone integer that keeps the page sequence increasing and stays
 * within MAX_PAGE_GAP of the previous chapter, which rejects in-title numbers.
 */
function parseContents(text: string): Map<number, string> {
  for (const re of [/Chapter\s+(\d{1,2})\s+/gi, /(?:^|\s)(\d{1,2})\.\s+/g]) {
    const markers: { n: number; start: number; end: number }[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      markers.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length });
    }

    // Only trust a run of consecutive chapter numbers starting at 1.
    const seq = markers.filter((mk, i) => mk.n === i + 1);
    if (seq.length < 3) continue;

    const out = new Map<number, string>();
    let prevPage = 0;

    for (let i = 0; i < seq.length; i++) {
      const to = i + 1 < seq.length ? seq[i + 1].start : text.length;
      let seg = text.slice(seq[i].end, to);

      const tail = TAIL.exec(seg);
      if (tail) seg = seg.slice(0, tail.index);

      // Locate this entry's page number among the standalone integers.
      let cut = seg.length;
      for (const nm of seg.matchAll(/\s(\d{1,3})(?!\d)/g)) {
        const value = Number(nm[1]);
        if (value > prevPage && value <= prevPage + MAX_PAGE_GAP) {
          cut = nm.index;
          prevPage = value;
          break;
        }
      }

      const title = normalise(seg.slice(0, cut));
      if (acceptable(title)) out.set(seq[i].n, title);
    }
    if (out.size >= 3) return out;
  }
  return new Map();
}

/** Text sitting in the top band of a page — the running header. */
async function headerBand(doc: PDFDocumentProxy, pageNo: number): Promise<string> {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return tc.items
    .filter((i): i is TextItem => "str" in i && !!i.str.trim() && i.transform[5] > vp.height * 0.88)
    .map((i) => i.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * NCERT runs the book name on one facing page and the chapter title on the
 * other, so scan a few pages and take the most frequent candidate that is not
 * the book's own name.
 */
async function titleFromHeaders(doc: PDFDocumentProxy, bookTitle: string): Promise<string | null> {
  const counts = new Map<string, number>();
  const bookNorm = normalise(bookTitle).toLowerCase();

  for (let p = 2; p <= Math.min(7, doc.numPages); p++) {
    const raw = await headerBand(doc, p);
    if (!raw) continue;
    // Strip the folio number sitting at the outer edge of the header.
    const title = normalise(raw.replace(/^\s*\d{1,3}\s+/, "").replace(/\s+\d{1,3}\s*$/, ""));
    if (!acceptable(title)) continue;
    // A running header is short; long text means we grabbed body copy.
    if (title.split(" ").length > 9) continue;
    const key = title.toLowerCase();
    if (key === bookNorm || bookNorm.includes(key) || key.includes(bookNorm)) continue;
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [title, count] of counts) {
    if (count > bestCount) {
      best = title;
      bestCount = count;
    }
  }
  // One sighting could be a stray caption; require it to repeat.
  return bestCount >= 2 ? best : null;
}

/** Last resort: the largest type on the chapter's first page. */
async function titleFromFirstPage(doc: PDFDocumentProxy): Promise<string | null> {
  const tc = await doc.getPage(1).then((p) => p.getTextContent());
  const items = tc.items.filter((i): i is TextItem => "str" in i && !!i.str.trim());

  const noise = (s: string) =>
    s.trim().length < 3 ||
    /^[\d\s.,:;|–—-]+$/.test(s) ||
    /^[ivxlcIVXLC]+$/.test(s.trim()) ||
    /^(chapter|unit|part|section)\s*\d*$/i.test(s.trim()) ||
    /notes for (the )?teacher/i.test(s);

  const lines = new Map<number, { height: number; parts: { x: number; str: string }[] }>();
  for (const it of items) {
    if (noise(it.str)) continue;
    const height = Math.abs(it.transform[3]) || it.height || 0;
    const y = Math.round(it.transform[5]);
    const line = lines.get(y) ?? { height: 0, parts: [] };
    line.height = Math.max(line.height, height);
    line.parts.push({ x: it.transform[4], str: it.str });
    lines.set(y, line);
  }

  const ordered = [...lines.entries()]
    .map(([y, l]) => ({
      y,
      height: l.height,
      text: normalise(
        l.parts
          .sort((a, b) => a.x - b.x)
          .map((p) => p.str)
          .join(" "),
      ),
    }))
    .filter((l) => l.text && !noise(l.text));
  if (ordered.length === 0) return null;

  const max = Math.max(...ordered.map((l) => l.height));
  // Only the single tallest band. Including near-equal bands tended to glue the
  // first subheading onto the title.
  const title = normalise(
    ordered
      .filter((l) => l.height >= max * 0.98)
      .sort((a, b) => b.y - a.y)
      .map((l) => l.text)
      .join(" "),
  );
  return acceptable(title) ? title : null;
}

/** Download (and cache) a book's prelims PDF. Not every book has one. */
async function getPrelims(code: string): Promise<Uint8Array | null> {
  const path = `${PRELIMS_DIR}/${code}ps.pdf`;
  if (existsSync(path)) return new Uint8Array(await readFile(path));
  try {
    const res = await fetchWithRetry(`${BASE}/textbook/pdf/${code}ps.pdf`);
    await sleep(500);
    if (res.status === 404) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
    await writeFile(path, buf);
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function contentsTitles(pdfjs: Pdfjs, code: string): Promise<Map<number, string>> {
  const data = await getPrelims(code);
  if (!data) return new Map();

  // pdf.js transfers the buffer it is handed, so open the document once and
  // read every page from that same instance.
  const doc = await pdfjs.getDocument({ data, ...FONT_OPTS }).promise;
  try {
    // The contents page sits near the back of the prelims; scan from the end.
    for (let p = doc.numPages; p >= 1; p--) {
      const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
      const text = tc.items
        .map((i) => ("str" in i ? i.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!/contents|अनुक्रम|विषय.?सूची/i.test(text)) continue;
      const parsed = parseContents(text);
      if (parsed.size >= 3) return parsed;
    }
  } finally {
    await doc.destroy();
  }
  return new Map();
}

async function main() {
  await mkdir(PRELIMS_DIR, { recursive: true });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const manifest = JSON.parse(await readFile("data/manifest.json", "utf8")) as Manifest;

  const overrides: Record<string, Record<string, string>> = existsSync(OVERRIDES)
    ? JSON.parse(await readFile(OVERRIDES, "utf8"))
    : {};

  const tally = { override: 0, contents: 0, header: 0, firstPage: 0, kept: 0, unresolved: 0 };
  const unresolved: string[] = [];

  for (const book of manifest.books) {
    const bookOverrides = overrides[book.code] ?? {};
    const todo = book.chapters.filter((c) => FORCE || isGeneric(c.title));
    if (todo.length === 0) {
      tally.kept += book.chapters.length;
      continue;
    }

    const skipExtraction = NEEDS_CURATION.has(book.code);
    const contents = skipExtraction ? new Map<number, string>() : await contentsTitles(pdfjs, book.code);
    console.log(
      `\n[${book.code}] ${book.title} — contents: ${contents.size ? `${contents.size} entries` : "none"}`,
    );

    for (const ch of book.chapters) {
      if (!FORCE && !isGeneric(ch.title)) {
        tally.kept++;
        continue;
      }
      const label = String(ch.n).padStart(2);

      const manual = bookOverrides[String(ch.n)];
      if (manual) {
        ch.title = manual;
        tally.override++;
        console.log(`  ${label}: ${manual}   [override]`);
        continue;
      }

      const fromToc = contents.get(ch.n);
      if (fromToc) {
        ch.title = fromToc;
        tally.contents++;
        console.log(`  ${label}: ${fromToc}   [contents]`);
        continue;
      }

      if (skipExtraction) {
        ch.title = `Chapter ${ch.n}`;
        tally.unresolved++;
        unresolved.push(`${book.code}:${ch.n}`);
        continue;
      }

      const path = `${PDF_ROOT}/${book.code}/${ch.file}`;
      if (!existsSync(path)) {
        ch.title = `Chapter ${ch.n}`;
        tally.unresolved++;
        unresolved.push(`${book.code}:${ch.n}`);
        console.log(`  ${label}: (no pdf)`);
        continue;
      }

      let resolved = false;
      try {
        const data = new Uint8Array(await readFile(path));
        const doc = await pdfjs.getDocument({ data, ...FONT_OPTS }).promise;
        try {
          const header = await titleFromHeaders(doc, book.title);
          if (header) {
            ch.title = header;
            tally.header++;
            resolved = true;
            console.log(`  ${label}: ${header}   [header]`);
          } else {
            const first = await titleFromFirstPage(doc);
            if (first) {
              ch.title = first;
              tally.firstPage++;
              resolved = true;
              console.log(`  ${label}: ${first}   [page 1]`);
            }
          }
        } finally {
          await doc.destroy();
        }
      } catch (err) {
        console.log(`  ${label}: ERROR ${(err as Error).message}`);
      }

      if (!resolved) {
        ch.title = `Chapter ${ch.n}`;
        tally.unresolved++;
        unresolved.push(`${book.code}:${ch.n}`);
        console.log(`  ${label}: (unresolved, left as "Chapter ${ch.n}")`);
      }
    }
  }

  await writeFile("data/manifest.json", JSON.stringify(manifest, null, 2));
  console.log(
    `\noverride ${tally.override}  contents ${tally.contents}  header ${tally.header}  ` +
      `page1 ${tally.firstPage}  kept ${tally.kept}  unresolved ${tally.unresolved}`,
  );
  if (unresolved.length) {
    console.log(`\nUnresolved: ${unresolved.join(", ")}`);
    console.log(`Add titles for these to ${OVERRIDES} and re-run.`);
  }
  console.log("Wrote data/manifest.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
