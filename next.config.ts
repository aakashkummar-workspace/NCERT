import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Fully static output: there is no server, so the whole app (including the
   * mirrored PDFs in public/) can be served from any static host.
   */
  output: "export",
  images: { unoptimized: true },
  // Static hosts serve /path/ as a directory, so emit path/index.html.
  trailingSlash: true,
};

export default nextConfig;
