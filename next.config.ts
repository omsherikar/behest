import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (the local and test database) loads its WebAssembly and optional Node modules at run
  // time, which the server bundler cannot follow; Node's own require loads it instead.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
