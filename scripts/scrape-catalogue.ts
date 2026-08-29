/**
 * Phase 0, step 1 — scrape NCERT's catalogue.
 *
 * ncert.nic.in/textbook.php drives its class -> subject -> book cascade from
 * inline JavaScript rather than an API. Each book lives in a block like:
 *
 *   else if((document.test.tclass.value==10) && (...text=="Science"))
 *   {
 *     document.test.tbook.options[1].text="Science";
 *     document.test.tbook.options[1].value="textbook.php?jesc1=0-13"
 *   }
 *
 * Withdrawn books are left in place but commented out with `//`, so comment
 * stripping is what separates the current syllabus from the retired one.
 *
 * Output: data/catalogue.raw.json
 */
import { writeFile } from "node:fs/promises";
import { BASE, fetchWithRetry, type RawBook } from "./lib/ncert";

const CATALOGUE_URL = `${BASE}/textbook.php`;

/** Matches the head of each class+subject book block. */
const BLOCK_RE =
  /else\s+if\s*\(\s*\(?\s*document\.test\.tclass\.value\s*==\s*(\d+)\s*\)?\s*&&\s*\(?\s*document\.test\.tsubject\.options\[sind\]\.text\s*==\s*"([^"]*)"\s*\)?\s*\)/g;

const TEXT_RE = /document\.test\.tbook\.options\[(\d+)\]\.text\s*=\s*"([^"]*)"/;
const VALUE_RE =
  /document\.test\.tbook\.options\[(\d+)\]\.value\s*=\s*"textbook\.php\?([a-z0-9]+)=0-(\d+)"/;

interface Entry {
  text?: string;
  code?: string;
  chapterCount?: number;
  withdrawn: boolean;
}

/**
 * Parse one class+subject block body into books.
 *
 * `.text` and `.value` are separate statements joined by their option index,
 * and either line may be individually commented out, so an entry counts as
 * withdrawn if *either* of its two lines is commented.
 */
function parseBlock(body: string, cls: number, subject: string): RawBook[] {
  const entries = new Map<number, Entry>();

  // Strip /* ... */ regions first; they wrap whole retired book lists.
  const withoutBlockComments = body.replace(/\/\*[\s\S]*?\*\//g, "");

  for (const rawLine of withoutBlockComments.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const commented = line.startsWith("//");
    const code = commented ? line.replace(/^\/+\s*/, "") : line;

    const textMatch = TEXT_RE.exec(code);
    if (textMatch) {
      const idx = Number(textMatch[1]);
      const e = entries.get(idx) ?? { withdrawn: false };
      e.text = textMatch[2].trim();
      e.withdrawn ||= commented;
      entries.set(idx, e);
      continue;
    }

    const valueMatch = VALUE_RE.exec(code);
    if (valueMatch) {
      const idx = Number(valueMatch[1]);
      const e = entries.get(idx) ?? { withdrawn: false };
      e.code = valueMatch[2];
      e.chapterCount = Number(valueMatch[3]);
      e.withdrawn ||= commented;
      entries.set(idx, e);
    }
  }

  const books: RawBook[] = [];
  for (const e of entries.values()) {
    // options[0] is the "..Select Book Title.." placeholder: no value, skip it.
    if (!e.code || !e.text || e.chapterCount === undefined) continue;
    books.push({
      code: e.code,
      title: e.text,
      class: cls,
      subject,
      chapterCount: e.chapterCount,
      withdrawn: e.withdrawn,
    });
  }
  return books;
}

async function main() {
  console.log(`Fetching ${CATALOGUE_URL} ...`);
  const res = await fetchWithRetry(CATALOGUE_URL);
  const html = await res.text();
  console.log(`  ${html.length.toLocaleString()} bytes`);

  // Collect block start offsets, then slice each block up to the next one.
  const starts: { index: number; cls: number; subject: string }[] = [];
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(html)) !== null) {
    starts.push({
      index: m.index + m[0].length,
      cls: Number(m[1]),
      subject: m[2].trim(),
    });
  }
  console.log(`  ${starts.length} class+subject blocks found`);

  const books: RawBook[] = [];
  for (let i = 0; i < starts.length; i++) {
    const { index, cls, subject } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index : html.length;
    books.push(...parseBlock(html.slice(index, end), cls, subject));
  }

  // The same book can be listed under more than one subject heading.
  const deduped = new Map<string, RawBook>();
  for (const b of books) {
    const existing = deduped.get(b.code);
    // Prefer the active listing if a code appears both active and withdrawn.
    if (!existing || (existing.withdrawn && !b.withdrawn)) deduped.set(b.code, b);
  }

  const all = [...deduped.values()].sort(
    (a, b) => a.class - b.class || a.subject.localeCompare(b.subject) || a.code.localeCompare(b.code),
  );

  await writeFile(
    "data/catalogue.raw.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), source: CATALOGUE_URL, books: all }, null, 2),
  );

  const c910 = all.filter((b) => b.class === 9 || b.class === 10);
  const active910 = c910.filter((b) => !b.withdrawn);
  console.log(`\nTotal books parsed:      ${all.length}`);
  console.log(`Class 9 & 10:            ${c910.length}  (${active910.length} active)`);
  console.log(`\nActive class 9 & 10 books:`);
  for (const b of active910) {
    console.log(`  [${b.class}] ${b.code.padEnd(7)} ${String(b.chapterCount).padStart(2)}ch  ${b.subject.padEnd(22)} ${b.title}`);
  }
  console.log(`\nWrote data/catalogue.raw.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
