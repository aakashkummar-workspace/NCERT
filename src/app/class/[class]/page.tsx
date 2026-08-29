import Link from "next/link";
import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import SubjectIcon from "@/components/SubjectIcon";
import { CLASSES, isClassNum, subjectsForClass } from "@/lib/manifest";

export function generateStaticParams() {
  return CLASSES.map((c) => ({ class: String(c) }));
}

export default async function ClassPage({ params }: PageProps<"/class/[class]">) {
  const { class: classParam } = await params;
  const cls = Number(classParam);
  if (!isClassNum(cls)) notFound();

  const subjects = subjectsForClass(cls);

  return (
    <>
      <AppHeader
        title={`Class ${cls}`}
        subtitle={`${subjects.length} subjects`}
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <ul className="grid gap-3 sm:grid-cols-2">
          {subjects.map((s) => (
            <li key={s.slug}>
              <Link
                href={`/class/${cls}/${s.slug}`}
                className="flex items-center gap-4 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/50"
              >
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                  <SubjectIcon slug={s.slug} className="size-6" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block text-xs text-ink-faint">
                    {s.books.length === 1 ? "1 book" : `${s.books.length} books`} ·{" "}
                    {s.chapterCount} chapters
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
