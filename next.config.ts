import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Runs on a Node runtime rather than exporting a static folder, so the app
   * can grow a server-side half (grading, accounts, evaluators) without
   * splitting into two deployments.
   *
   * The reader is unaffected: every route under /class, /read, /quiz,
   * /practice and /past-papers still has generateStaticParams and is still
   * prerendered to static HTML at build time, then CDN-served. Confirm with
   * the route table printed by `next build` — those routes must stay ○/●,
   * never ƒ.
   */
  images: { unoptimized: true },
  /*
   * Must stay true. The service worker keys its shell cache on request URLs,
   * which are the /path/ form; dropping it would 308 every cached entry on
   * every existing install and silently orphan the cache.
   */
  trailingSlash: true,
};

export default nextConfig;
