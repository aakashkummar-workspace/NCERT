# Copyright and permissions

## Position

All textbook content in this project is **© NCERT** (National Council of Educational Research
and Training). This project claims no ownership of it and is not affiliated with, nor endorsed
by, NCERT or CBSE.

NCERT permits free download of its e-content for personal use, but treats republishing without
permission as infringement — see NCERT's
[press release on copyright infringement](https://www.ncert.nic.in/pdf/announcement/notices/Press_Release_Copyright_Infringement-NCERT.pdf).
Serving copies of the PDFs, as this app does, is republishing.

## Why the files are mirrored rather than linked

This is a technical constraint, not a preference. ncert.nic.in serves its chapter PDFs with:

- **no `Access-Control-Allow-Origin` header** — a browser on another origin cannot `fetch()`
  them, so pdf.js cannot load them; and
- **`X-Frame-Options: SAMEORIGIN`** — they cannot be embedded in an `<iframe>` either.

Verify at any time:

```bash
curl -sI https://ncert.nic.in/textbook/pdf/jesc101.pdf | grep -iE 'access-control|x-frame'
```

An in-app reader therefore requires the files on our own origin. The only alternative that
avoids republishing entirely is to send students out to ncert.nic.in, which is not the product.

## Mitigations in place

- **Non-commercial.** No ads, no paywall, no accounts, no analytics, no payments.
- **Content unaltered in substance.** Chapters are re-compressed for download size and are
  therefore **not** byte-identical to NCERT's originals. Images are downsampled to 150 dpi;
  nothing is added, removed or edited. Every original is preserved in `data/ncert-original/`
  (gitignored) so the exact published file can be restored at any time, and `originalBytes` in
  `data/manifest.json` records the pre-compression size.

  ⚠️ **Ghostscript's `/ebook` and `/printer` presets must never be used here.** Both silently
  drop images: on a sample chapter they cut the page from 3 image-paint operations to 1, and
  what vanished was NCERT's own diagonal "not to be republished" watermark. Removing a rights
  holder's copyright notice while republishing their file is materially worse than republishing
  it intact. `scripts/compress-pdfs.ts` therefore uses explicit downsampling flags only, and a
  visual check against `data/ncert-original/` should accompany any change to those flags.
- **Attribution everywhere.** Every chapter links back to its official ncert.nic.in source, and
  `/about` names NCERT as the copyright holder.
- **Follows the official catalogue.** Book codes, chapter counts and the current-vs-withdrawn
  distinction are read from NCERT's own catalogue page, so the app tracks the live syllabus
  rather than perpetuating superseded editions.
- **Takedown path.** `/about` invites NCERT to request removal, and the whole corpus can be
  removed by deleting `public/ncert/` and redeploying.

## Open action — permission request

**Status: not yet sent.**

A written permission request should go to NCERT before any public deployment. Contact:
`pd.ncert@nic.in` (the address NCERT publishes for copyright matters).

The request should state: the non-commercial and free nature of the app, that content is
unmodified and attributed, that it links back to ncert.nic.in, the technical reason mirroring
is unavoidable (CORS and `X-Frame-Options`, above), and an undertaking to remove anything NCERT
asks to have removed.

Record the outcome here:

| Date | Action | Outcome |
| --- | --- | --- |
| — | Permission request drafted | pending |
