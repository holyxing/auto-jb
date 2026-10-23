import { build } from "esbuild";
import { mkdir, copyFile, rm, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = (await readdir("extension/src"))
  .filter((name) => name.endsWith(".ts"))
  .sort();
const sources = await Promise.all(
  files.map((name) => readFile(`extension/src/${name}`, "utf8")),
);
const version = createHash("sha256")
  .update(sources.join("\n"))
  .digest("hex")
  .slice(0, 12);
await rm("dist/extension", { recursive: true, force: true });
await mkdir("dist/extension", { recursive: true });
for (const name of ["content", "worker", "popup"])
  await build({
    entryPoints: [`extension/src/${name}.ts`],
    outfile: `dist/extension/${name}.js`,
    bundle: true,
    format: "iife",
    target: "chrome120",
    minify: false,
    define: { __ADAPTER_VERSION__: JSON.stringify(version) },
  });
for (const file of ["manifest.json", "popup.html", "jobTitles.json"])
  await copyFile(`extension/${file}`, `dist/extension/${file}`);
