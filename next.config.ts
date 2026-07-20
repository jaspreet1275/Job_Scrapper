import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    // Pin the Turbopack root to this directory. Next infers the root by
    // scanning upward for a lockfile, and here it was landing on the parent
    // (D:\Manatanu) instead of the project. Turbopack refuses to resolve
    // anything outside its root, so `@import "tailwindcss"` in globals.css
    // failed to resolve and every page rendered unstyled.
    root: path.resolve(__dirname),
  },

  // /api/send-email reads public/manatanu-logo.jpg off disk to ship it as an
  // inline CID attachment. Static assets under public/ are served by the CDN
  // and are NOT traced into the serverless function bundle, so without this
  // the read succeeds locally and throws ENOENT once deployed.
  outputFileTracingIncludes: {
    "/api/send-email": ["./public/manatanu-logo.jpg"],
  },

  // Allow the ngrok tunnel host to load Next.js dev resources (HMR + static
  // chunks). Required so the email-tracking pixel can be served via the
  // public ngrok URL without Next blocking cross-origin requests.
  // Add new ngrok subdomains here when the URL rotates.
  allowedDevOrigins: [
    "b65f-122-176-161-12.ngrok-free.app",
    "*.ngrok-free.app",
    "*.ngrok.io",
  ],
};

export default nextConfig;
