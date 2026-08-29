import AppHeader from "@/components/AppHeader";
import WeakAreas from "@/components/WeakAreas";

export const metadata = { title: "Where your marks are — NCERT Quick" };

export default function ProgressPage() {
  return (
    <>
      <AppHeader
        title="Where your marks are"
        subtitle="CBSE weightage against your confidence"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <WeakAreas />
      </main>
    </>
  );
}
