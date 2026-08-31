import AppHeader from "@/components/AppHeader";
import ResultsList from "./ResultsList";

export const metadata = { title: "Marked scripts — NCERT Quick" };

export default function ResultsPage() {
  return (
    <>
      <AppHeader
        title="Marked scripts"
        subtitle="Every answer sheet you have photographed"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <ResultsList />
      </main>
    </>
  );
}
