import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const dist = resolve(root, "dist");
const forbiddenObserverImportPattern = /(?:from|import)[^;\n]*\b(?:QueryObserver|QueriesObserver|InfiniteQueryObserver)\b/;
const forbiddenObserverConstructorPattern = /\b(?:new\s+)?(?:QueryObserver|QueriesObserver|InfiniteQueryObserver)\s*\(/;

async function outputFiles() {
  try {
    return await readdir(dist, { recursive: true });
  } catch (error) {
    throw new Error(`Cannot inspect ${dist}; run the ESM build first.`, { cause: error });
  }
}

async function collectReachable(entry) {
  const pending = [resolve(dist, entry)];
  const visited = new Set();
  let source = "";
  while (pending.length > 0) {
    const filename = pending.pop();
    if (filename === undefined || visited.has(filename)) continue;
    visited.add(filename);
    const current = await readFile(filename, "utf8");
    source += `\n${current}`;
    for (const match of current.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const dependency = resolve(dirname(filename), specifier);
      if (extname(dependency) === ".mjs") pending.push(dependency);
    }
  }
  return { source, visited };
}

function assertNoObserverConstructors(filename, source) {
  if (forbiddenObserverImportPattern.test(source) || forbiddenObserverConstructorPattern.test(source)) {
    throw new Error(
      `${filename} references a forbidden TanStack observer implementation. ` +
      "The public hooks must not import or construct QueryObserver, QueriesObserver, or InfiniteQueryObserver.",
    );
  }
}

async function assertDeclarations(files) {
  const declarations = files.filter((file) => file.endsWith(".d.ts") || file.endsWith(".d.mts"));
  if (declarations.length === 0) throw new Error("The build did not emit any declaration files.");

  for (const relative of declarations) {
    const filename = resolve(dist, relative);
    const source = await readFile(filename, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\(|export\s+\*\s+from\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith(".")) continue;
      if (specifier.includes("/src/") || specifier.endsWith(".ts") || specifier.endsWith(".tsx")) {
        throw new Error(`Invalid source declaration specifier in ${relative}: ${specifier}`);
      }
      const target = resolve(dirname(filename), specifier);
      const candidates = [
        target,
        `${target}.d.ts`,
        `${target}.d.mts`,
        target.replace(/\.(?:mjs|cjs|js)$/, ".d.ts"),
        target.replace(/\.(?:mjs|cjs|js)$/, ".d.mts"),
      ];
      let resolved = false;
      for (const candidate of candidates) {
        try {
          await readFile(candidate);
          resolved = true;
          break;
        } catch {
          // Keep checking the NodeNext declaration candidates.
        }
      }
      if (!resolved) {
        throw new Error(`Unresolved relative declaration specifier in ${relative}: ${specifier}`);
      }
    }
  }
}

async function assertPackageTypeExport() {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const typeSpecifier = packageJson.exports?.["."]?.types;
  if (typeof typeSpecifier !== "string" || !typeSpecifier.startsWith("./dist/")) {
    throw new Error("The package root must expose a dist declaration through exports['.'].types.");
  }
  try {
    await readFile(resolve(root, typeSpecifier));
  } catch (error) {
    throw new Error(`The package declaration export does not resolve: ${typeSpecifier}`, { cause: error });
  }
}

async function assertConsumerBundle() {
  const result = await build({
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent",
    external: ["react", "react-dom", "@tanstack/react-query", "@tanstack/query-core"],
    entryPoints: [resolve(dist, "index.mjs")],
  });
  const bundled = result.outputFiles[0]?.text;
  if (bundled === undefined) throw new Error("esbuild did not emit an ESM consumer bundle.");
  assertNoObserverConstructors("esbuild consumer bundle", bundled);
}

const files = await outputFiles();
if (!files.includes("index.mjs")) throw new Error("Missing ESM output dist/index.mjs.");
if (files.some((file) => file.endsWith(".cjs"))) {
  throw new Error("CJS output was generated even though this package is ESM-only.");
}

const reachable = await collectReachable("index.mjs");
for (const filename of reachable.visited) {
  assertNoObserverConstructors(filename.replace(`${dist}/`, "dist/"), await readFile(filename, "utf8"));
}
await assertDeclarations(files);
await assertPackageTypeExport();
await assertConsumerBundle();
