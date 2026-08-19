import { readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { transformFileAsync } from "@babel/core";
import reactCompiler from "babel-plugin-react-compiler";

const sourceDirectory = resolve(process.cwd(), "src");

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(filename));
    } else if (extname(entry.name) === ".ts" || extname(entry.name) === ".tsx") {
      files.push(filename);
    }
  }
  return files;
}

const files = await sourceFiles(sourceDirectory);
if (files.length === 0) throw new Error("No public hook modules were found under src/.");

for (const filename of files) {
  const relative = filename.replace(`${process.cwd()}/`, "");
  try {
    await transformFileAsync(filename, {
      filename,
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: [[reactCompiler, { panicThreshold: "all_errors", target: "19" }]],
    });
  } catch (error) {
    throw new Error(`React Compiler rejected ${relative}.`, { cause: error });
  }
}
