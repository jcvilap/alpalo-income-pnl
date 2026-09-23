import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Next doesn't infer it from an unrelated parent
  // lockfile (e.g. ~/yarn.lock). Keeps builds deterministic on Vercel.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
