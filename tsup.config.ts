import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  clean: true,
  dts: false,
  splitting: true,
  sourcemap: true,
  treeshake: true,
  outExtension: () => ({ js: ".mjs" }),
  external: ["react", "react-dom", "@tanstack/react-query", "@tanstack/query-core"],
});
