import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";

const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = await mkdtemp(join(tmpdir(), "tanstack-lite-benchmark-"));
let server;
let browser;

try {
  await build({
    root: benchmarkDirectory,
    configFile: false,
    base: "./",
    logLevel: "warn",
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      minify: true,
      sourcemap: false,
      rollupOptions: { input: join(benchmarkDirectory, "index.html") },
    },
  });

  server = await preview({
    root: benchmarkDirectory,
    configFile: false,
    logLevel: "warn",
    build: { outDir: outputDirectory },
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Vite preview did not expose a TCP port");
  }

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(20 * 60 * 1_000);
  page.on("console", (message) => {
    if (message.type() === "error") {
      globalThis.console.error(`[browser] ${message.text()}`);
    }
  });
  await page.goto(`http://127.0.0.1:${address.port}/`, {
    waitUntil: "networkidle",
  });

  const report = await page.evaluate(() =>
    globalThis.runQueryLibraryBenchmarks((message) =>
      globalThis.console.log(message),
    ),
  );
  globalThis.console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    const coreFailures = report.comparisons
      .filter((comparison) => !comparison.passed)
      .map(
        (comparison) =>
          `${comparison.mode}/${comparison.phase}: Lite ${comparison.liteMs}ms, native ${comparison.nativeMs}ms, SWR ${comparison.swrMs}ms`,
      );
    const largeFailures = report.largeUseQueries.comparisons
      .filter((comparison) => !comparison.passed)
      .map(
        (comparison) =>
          `large useQueries/${comparison.phase}: Lite 20k ${comparison.lite20kMs}ms, native 20k ${comparison.native20kMs}ms, scaling ${comparison.liteScaling}x`,
      );
    const dedupeFailure = report.fetchDedupePassed
      ? []
      : ["fetch deduplication acceptance failed"];
    globalThis.console.error(
      `Performance acceptance failed:\n${[
        ...coreFailures,
        ...largeFailures,
        ...dedupeFailure,
      ].join("\n")}`,
    );
    globalThis.process.exitCode = 1;
  }
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
  await rm(outputDirectory, { recursive: true, force: true });
}
