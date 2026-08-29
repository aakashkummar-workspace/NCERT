/**
 * Diagnostic helper for curating data/title-overrides.json.
 *
 * Prints the raw text of every prelims page that looks like a Contents page,
 * so titles that automated parsing cannot pull out can still be read off the
 * real source rather than guessed at.
 *
 *   npx tsx scripts/dump-contents.ts jeff1 jess2 ihga1
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const FONT_OPTS = {
  cMapUrl: "node_modules/pdfjs-dist/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  useSystemFonts: true,
} as const;

async function main() {
  // --all prints every prelim page, for books whose contents page carries no
  // recognisable heading.
  const all = process.argv.includes("--all");
  const codes = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (codes.length === 0) {
    console.error("usage: npx tsx scripts/dump-contents.ts <bookCode> [bookCode...]");
    process.exit(1);
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  for (const code of codes) {
    const path = `data/prelims/${code}ps.pdf`;
    if (!existsSync(path)) {
      console.log(`\n===== ${code}: no prelims cached (run extract-titles first) =====`);
      continue;
    }
    const data = new Uint8Array(await readFile(path));
    const doc = await pdfjs.getDocument({ data, ...FONT_OPTS }).promise;
    console.log(`\n===== ${code} (${doc.numPages} prelim pages) =====`);
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
      const text = tc.items
        .map((i) => ("str" in i ? i.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!all && !/contents|अनुक्रम|विषय.?सूची/i.test(text)) continue;
      if (!text) continue;
      console.log(`--- page ${p} ---`);
      console.log(text);
    }
    await doc.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
