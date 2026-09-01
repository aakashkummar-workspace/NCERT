import AppHeader from "@/components/AppHeader";
import GradeSync from "@/components/GradeSync";
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
        {/* Marks awarded elsewhere land here before the queue is drawn: a card
            rated on a self-mark the teacher has since overruled is the wrong
            card to be shown. See src/lib/handoff-sync.ts. */}
        <div className="mb-4 empty:mb-0">
          <GradeSync />
        </div>
        <RevisionQueue />
      </main>
    </>
  );
}
