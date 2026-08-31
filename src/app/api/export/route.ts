/**
 * GET /api/export/                       — the column map, as JSON
 * GET /api/export/?dataset=attempts      — CSV
 * GET /api/export/?dataset=chapters      — CSV
 *
 * ADMIN only, and scoped to the admin's **own** scope. An admin is an admin of
 * a scope, not of the platform (docs/PLATFORM.md §1). Today every B2C row is on
 * the nil UUID and the filter reads as ceremony; the day it is not, the query
 * that forgot is the one that hands one school another school's marks — as a
 * spreadsheet, which is worse than a screen because it has no expiry and no
 * second login.
 *
 * ## CSV first, and why there is no XLSX
 *
 * `.xlsx` is a zip of XML parts and needs a library. There is no such
 * dependency in this repo and docs/PLATFORM.md §8 says not to add one quietly.
 * Excel, LibreOffice and Google Sheets all open this file correctly as it
 * stands: it is UTF-8 with a BOM (without which every Devanagari name arrives
 * as mojibake), CRLF-terminated per RFC 4180, and every cell that could be read
 * as a formula is defused. If a school genuinely needs a workbook, that is a
 * dependency to add on purpose.
 *
 * ## The export cannot see more than a parent can
 *
 * Both datasets are assembled from selects that pass the same
 * `assertDisclosable()` gate as the dashboard. That is the point of the two
 * living in one module: an export is a parent dashboard with no login, no
 * expiry and a third-party recipient, so it must not be the more permissive of
 * the two. See src/lib/export.ts.
 */
import { NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api";
import {
  ATTEMPT_COLUMNS,
  CHAPTER_COLUMNS,
  columnMap,
  toCsv,
  type ExportDataset,
} from "@/lib/export";
import { exportAttempts, exportChapters } from "@/lib/parent";

const DATASETS: readonly ExportDataset[] = ["attempts", "chapters"];

function csvResponse(body: string, filename: string): NextResponse {
  return new NextResponse(body, {
    headers: {
      // `charset=utf-8` alongside the BOM: belt and braces, because the two
      // are read by different importers.
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      // A marks export must never sit in a shared proxy cache.
      "cache-control": "no-store",
    },
  });
}

export const GET = route({ auth: "ADMIN" }, async ({ user, req }) => {
  const asked = req.nextUrl.searchParams.get("dataset");

  if (!asked) {
    return {
      datasets: DATASETS,
      usage: "GET /api/export/?dataset=attempts — note the trailing slash on the path.",
      format: {
        encoding: "UTF-8 with BOM",
        lineEnding: "CRLF (RFC 4180)",
        quoting: 'a cell is quoted when it contains a comma, a double quote, CR or LF; inner quotes are doubled',
        formulaGuard:
          "a cell beginning = + - @ tab or CR is prefixed with an apostrophe, which spreadsheets render as plain text",
        blanks: "an unscored attempt exports an empty cell, never a zero",
      },
      columns: columnMap(),
    };
  }

  if (!DATASETS.includes(asked as ExportDataset)) {
    throw ApiError.validation([
      { path: "dataset", message: `must be one of: ${DATASETS.join(", ")}` },
    ]);
  }

  const stamp = new Date().toISOString().slice(0, 10);

  if (asked === "attempts") {
    const rows = await exportAttempts(user.scopeId);
    return csvResponse(toCsv(rows, ATTEMPT_COLUMNS), `ncert-attempts-${stamp}.csv`);
  }

  const rows = await exportChapters(user.scopeId);
  return csvResponse(toCsv(rows, CHAPTER_COLUMNS), `ncert-chapters-${stamp}.csv`);
});
