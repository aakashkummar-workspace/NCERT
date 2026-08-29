import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import { manifest } from "@/lib/manifest";

export const metadata = { title: "About & sources — NCERT Quick" };

export default function AboutPage() {
  const chapters = manifest.books.reduce((n, b) => n + b.chapters.length, 0);

  return (
    <>
      <AppHeader title="About & sources" back={{ href: "/", label: "home" }} />
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-6 text-sm leading-relaxed">
        <section>
          <h2 className="mb-2 font-semibold">What this is</h2>
          <p className="text-ink-soft">
            A free, non-commercial reader for NCERT Class 9 and Class 10 textbooks. It carries{" "}
            {manifest.books.length} books and {chapters} chapters across Science, Mathematics,
            Social Science, English and Hindi, and works offline once a chapter is downloaded.
            There are no ads, no accounts and no payments.
          </p>
        </section>

        <section>
          <h2 className="mb-2 font-semibold">Where the content comes from</h2>
          <p className="text-ink-soft">
            Every chapter is the official PDF published by the National Council of Educational
            Research and Training at{" "}
            <a
              href="https://ncert.nic.in/textbook.php"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline underline-offset-4"
            >
              ncert.nic.in
            </a>
            . The book list, codes and chapter counts are read directly from NCERT&apos;s own
            catalogue, so the app follows the current syllabus rather than a hand-typed copy.
          </p>
          <p className="mt-2 text-ink-soft">
            NCERT serves these files without cross-origin access headers, so a web app cannot load
            them directly from ncert.nic.in. Copies are therefore served from this site. Every
            chapter links back to its official source, and nothing has been edited — files are
            re-compressed only to reduce download size on slow connections.
          </p>
          <p className="mt-2 text-xs text-ink-faint">
            Catalogue last read {new Date(manifest.generatedAt).toLocaleDateString()}.
          </p>
        </section>

        <section>
          <h2 className="mb-2 font-semibold">Copyright</h2>
          <p className="text-ink-soft">
            All textbook content is © NCERT. This project claims no ownership of it and is not
            affiliated with or endorsed by NCERT or CBSE. If you represent NCERT and want any
            material removed, please get in touch and it will be taken down promptly.
          </p>
        </section>

        <section>
          <h2 className="mb-2 font-semibold">Offline storage</h2>
          <p className="text-ink-soft">
            Downloaded chapters live in your browser&apos;s storage on this device only. Nothing is
            uploaded anywhere. You can review and clear them from the{" "}
            <Link href="/downloads" className="text-accent underline underline-offset-4">
              downloads page
            </Link>
            .
          </p>
        </section>
      </main>
    </>
  );
}
