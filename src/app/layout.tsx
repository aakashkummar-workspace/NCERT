import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import ServiceWorker from "@/components/ServiceWorker";
import TabBar from "@/components/TabBar";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NCERT Quick — Class 9 & 10 Textbooks",
  description:
    "Read NCERT Class 9 and Class 10 textbooks offline. Science, Maths, Social Science, English and Hindi.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "NCERT Quick", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf9f6" },
    { media: "(prefers-color-scheme: dark)", color: "#14130f" },
  ],
  width: "device-width",
  initialScale: 1,
  // The reader needs pinch-zoom on dense diagrams and maps.
  maximumScale: 5,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        {/* Persistent navigation. Renders its own in-flow spacer, so no page
            needs to reserve room for it, and disappears on the reader. */}
        <TabBar />
        <ServiceWorker />
      </body>
    </html>
  );
}
