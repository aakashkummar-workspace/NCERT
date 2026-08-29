import AppHeader from "@/components/AppHeader";
import RevisionQueue from "@/components/RevisionQueue";

export const metadata = { title: "Revise — NCERT Quick" };

export default function RevisePage() {
  return (
    <>
      <AppHeader
        title="Revise"
        subtitle="Questions you got wrong, resurfaced on schedule"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <RevisionQueue />
      </main>
    </>
  );
}
