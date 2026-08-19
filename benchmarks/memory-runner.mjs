import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";

const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = await mkdtemp(
  join(tmpdir(), "tanstack-lite-memory-benchmark-"),
);
const libraries = ["lite", "native"];
const queryCounts = [10_000, 20_000];
let server;
let browser;

async function collectMemory(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  const [heap, dom] = await Promise.all([
    cdp.send("Runtime.getHeapUsage"),
    cdp.send("Memory.getDOMCounters"),
  ]);
  return {
    usedSize: heap.usedSize,
    totalSize: heap.totalSize,
    embedderHeapUsedSize: heap.embedderHeapUsedSize,
    backingStorageSize: heap.backingStorageSize,
    documents: dom.documents,
    nodes: dom.nodes,
    jsEventListeners: dom.jsEventListeners,
  };
}
function subtract(after, before) {
  return Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key] - before[key]]),
  );
}

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
      rollupOptions: { input: join(benchmarkDirectory, "memory.html") },
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
  const results = [];
  for (const queryCount of queryCounts) {
    const order =
      queryCount === 10_000 ? libraries : [...libraries].reverse();
    for (const library of order) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10 * 60 * 1_000);
        const cdp = await context.newCDPSession(page);
        await cdp.send("HeapProfiler.enable");
        await page.goto(`http://127.0.0.1:${address.port}/memory.html`, {
          waitUntil: "networkidle",
        });
        const baseline = await collectMemory(cdp);
        await page.evaluate(
          ({ selectedLibrary, selectedQueryCount }) =>
            globalThis.mountMemoryBenchmark(
              selectedLibrary,
              selectedQueryCount,
            ),
          {
            selectedLibrary: library,
            selectedQueryCount: queryCount,
          },
        );
        const mounted = await collectMemory(cdp);
        await page.evaluate(() => globalThis.teardownMemoryBenchmark());
        const afterTeardown = await collectMemory(cdp);
        results.push({
          library,
          queryCount,
          baseline,
          mounted,
          retainedDelta: subtract(mounted, baseline),
          afterTeardown,
          teardownDelta: subtract(afterTeardown, baseline),
        });
      } finally {
        await context.close();
      }
    }
  }

  globalThis.console.log(
    JSON.stringify(
      {
        methodology: {
          productionBundle: true,
          freshBrowserContextPerMeasurement: true,
          preseededQueries: true,
          passiveSubscriptionsSettled: true,
          garbageCollection: "CDP HeapProfiler.collectGarbage",
          heapMeasurement: "CDP Runtime.getHeapUsage",
          domMeasurement: "CDP Memory.getDOMCounters",
          teardown: "React unmount, QueryClient.clear, DOM removal, two frames",
        },
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
  await rm(outputDirectory, { recursive: true, force: true });
}
