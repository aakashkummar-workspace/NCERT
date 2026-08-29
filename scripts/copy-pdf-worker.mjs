/**
 * pdf.js runs its parser in a web worker. The worker must be served from our
 * own origin, so copy it out of node_modules into public/ before every build.
 */
import { copyFile, mkdir } from "node:fs/promises";

const SRC = "node_modules/pdfjs-dist/build/pdf.worker.min.mjs";
const DEST = "public/pdf.worker.min.mjs";

await mkdir("public", { recursive: true });
await copyFile(SRC, DEST);
console.log(`copied ${SRC} -> ${DEST}`);
