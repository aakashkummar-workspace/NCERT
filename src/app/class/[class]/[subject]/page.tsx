import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import ChapterList from "@/components/ChapterList";
import { CLASSES, getSubject, isClassNum, subjectsForClass } from "@/lib/manifest";

export function generateStaticParams() {
  return CLASSES.flatMap((cls) =>
    subjectsForClass(cls).map((s) => ({ class: String(cls), subject: s.slug })),
  );
}

export default async function SubjectPage({ params }: PageProps<"/class/[class]/[subject]">) {
  const { class: classParam, subject: subjectSlug } = await params;
  const cls = Number(classParam);
  if (!isClassNum(cls)) notFound();

  const subject = getSubject(cls, subjectSlug);
  if (!subject) notFound();

  return (
    <>
      <AppHeader
        title={subject.name}
        subtitle={`Class ${cls} · ${subject.chapterCount} chapters`}
        back={{ href: `/class/${cls}`, label: `class ${cls}` }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        {subject.books.map((book) => {
          /*
           * A book heading only earns its place when it says something the app
           * bar has not already said. Class 10 Science is one book called
           * "Science" under a bar reading "Science / Class 10 · 13 chapters",
           * so the heading was pure repetition above the fold.
           *
           * It stays wherever the name is real information: subjects shipping
           * several books (Class 10 Social Science has four, English two), and
           * the Class 9 NCF books, whose titles — "Exploration", "Kaveri",
           * "Ganita Manjari" — are nothing like their subject names.
           */
          const named = subject.books.length > 1 || book.title !== subject.name;
          return (
            <section key={book.code} className="mb-8 last:mb-0">
              {named && (
                <div className="mb-3">
                  <h2 className="font-semibold break-words">{book.title}</h2>
                  <p className="text-xs text-ink-faint">
                    {book.chapters.length} chapters · NCERT code {book.code}
                  </p>
                </div>
              )}
              <ChapterList book={book} cls={cls} subject={subject.name} />
            </section>
          );
        })}
      </main>
    </>
  );
}
