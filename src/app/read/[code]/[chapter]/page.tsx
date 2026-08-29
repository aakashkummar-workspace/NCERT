import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import PdfReader from "@/components/PdfReader";
import {
  allChapters,
  chapterNeighbours,
  getBook,
  getChapter,
  officialUrl,
  pdfPath,
  slugify,
} from "@/lib/manifest";

export function generateStaticParams() {
  return allChapters().map(({ code, chapter }) => ({
    code,
    chapter: String(chapter.n),
  }));
}

export default async function ReadPage({ params }: PageProps<"/read/[code]/[chapter]">) {
  const { code, chapter: chapterParam } = await params;
  const n = Number(chapterParam);

  const book = getBook(code);
  const chapter = getChapter(code, n);
  if (!book || !chapter) notFound();

  const { prev, next } = chapterNeighbours(code, n);

  return (
    <>
      <AppHeader
        title={chapter.title}
        /* Several books are titled after their subject ("Science"), so only
           name the book when it adds something. */
        subtitle={
          book.title === book.subject
            ? `Class ${book.class} · ${book.subject}`
            : `Class ${book.class} · ${book.subject} · ${book.title}`
        }
        back={{ href: `/class/${book.class}/${slugify(book.subject)}`, label: book.subject }}
      />
      <PdfReader
        url={pdfPath(book.code, chapter.file)}
        code={book.code}
        chapter={chapter.n}
        officialUrl={officialUrl(chapter.file)}
        prevHref={prev ? `/read/${code}/${prev.n}` : undefined}
        nextHref={next ? `/read/${code}/${next.n}` : undefined}
      />
    </>
  );
}
