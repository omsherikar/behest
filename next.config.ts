import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The build writes a self-contained server to .next/standalone (server.js and only the files it
  // needs), which the Docker image runs with `node server.js`.
  output: "standalone",
  // PGlite (the local and test database) loads its WebAssembly and optional Node modules at run
  // time, which the server bundler cannot follow; Node's own require loads it instead.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The demo reset reads Ravi's catalog CSV at run time, which the tracer cannot see from its imports.
  outputFileTracingIncludes: { "/api/demo/reset": ["./lib/demo/ravi-spices.csv"] },
};

export default nextConfig;
