/**
 * Shared types and helpers for the NCERT content pipeline.
 *
 * Book codes follow NCERT's own convention: [class][medium][subject][book#]
 *   i = class IX, j = class X
 *   e = English medium, h = Hindi, u = Urdu, s = Sanskrit
 * A chapter PDF is `<code><NN>.pdf`, e.g. jesc1 + "01" -> jesc101.pdf
 */

export const BASE = "https://ncert.nic.in";

export type Medium = "en" | "hi" | "ur" | "sa" | "other";

export interface RawBook {
  /** NCERT book code, e.g. "jesc1" */
  code: string;
  /** Book title as printed in the NCERT catalogue */
  title: string;
  /** Class the catalogue filed this book under */
  class: number;
  /** Subject the catalogue filed this book under */
  subject: string;
  /** Number of chapters the catalogue declares */
  chapterCount: number;
  /** True when the catalogue entry was commented out (withdrawn book) */
  withdrawn: boolean;
}

export interface Chapter {
  n: number;
  title: string;
  /** Basename of the PDF, e.g. "jesc101.pdf" */
  file: string;
  bytes?: number;
  originalBytes?: number;
  sha256?: string;
}

export interface Book {
  code: string;
  class: 9 | 10;
  subject: string;
  medium: Medium;
  title: string;
  /** Set for books NCERT still serves but no longer lists as current */
  legacy?: boolean;
  chapters: Chapter[];
}

export interface Manifest {
  generatedAt: string;
  source: string;
  books: Book[];
}

/** Medium letter is the 2nd character of the book code. */
export function mediumOf(code: string): Medium {
  switch (code[1]) {
    case "e": return "en";
    case "h": return "hi";
    case "u": return "ur";
    case "s": return "sa";
    default: return "other";
  }
}

export function chapterFile(code: string, n: number): string {
  return `${code}${String(n).padStart(2, "0")}.pdf`;
}

export function chapterUrl(code: string, n: number): string {
  return `${BASE}/textbook/pdf/${chapterFile(code, n)}`;
}

/** Human-readable slug used in app routes, e.g. "social-science". */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch with retries; NCERT's server is occasionally flaky under sequential load. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 4,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || res.status === 404) return res;
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(1000 * (i + 1));
  }
  throw lastErr;
}
