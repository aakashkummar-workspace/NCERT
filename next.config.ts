import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Next infers the workspace root from the nearest enclosing lockfile, and on
   * this machine there is a stray `package-lock.json` in the home directory
   * above OneDrive — so it infers `C:\Users\<name>` and warns. The inference is
   * only wrong locally: a Vercel build clones into a directory with exactly one
   * lockfile and would resolve to the project anyway. Pinning it says out loud
   * what the hosted build already does, and stops the local warning that would
   * otherwise train someone to ignore build output.
   *
   * It also bounds file tracing to this directory, which matters more than the
   * warning does: tracing a OneDrive-synced home directory is slow and can pull
   * unrelated files into a serverless bundle.
   */
  outputFileTracingRoot: path.resolve(__dirname),
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
