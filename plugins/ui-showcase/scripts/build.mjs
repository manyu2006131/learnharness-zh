import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error("拒绝构建到链接目录。");
  try { fs.lstatSync(path.join(output, "data")); throw new Error("拒绝覆盖插件数据进行构建。请先将其移到安全位置。"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
} catch (error) { if (error.code !== "ENOENT") throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: path.join(output, "main.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
  metafile: true,
});
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith("src/")) throw new Error(`Unexpected runtime input in UI Showcase bundle: ${input}`);
}
for (const [from, to] of [["manifest.json", "manifest.json"], ["src/styles.css", "styles.css"], ["README.md", "README.md"], ["LICENSE", "LICENSE"]]) {
  fs.copyFileSync(path.join(root, from), path.join(output, to));
}
console.log(`Built installable frontend-only package: ${output}`);
console.log(`Browser bundle: ${fs.statSync(path.join(output, "main.js")).size} bytes; no runtime dependencies.`);
