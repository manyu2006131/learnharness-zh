import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error("拒绝构建到符号链接的 dist 目录。");
  try { fs.lstatSync(path.join(output, "data")); throw new Error("拒绝覆盖 dist/data 进行构建；请先将插件数据保存到 dist 之外。"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
} catch (error) { if (error.code !== "ENOENT") throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const common = { absWorkingDir: root, bundle: true, target: "es2022", minify: true, legalComments: "eof", metafile: true };
const frontend = await build({ ...common, entryPoints: ["src/main.ts"], outfile: path.join(output, "main.js"), format: "esm", platform: "browser" });
const backend = await build({ ...common, entryPoints: ["src/backend.ts"], outfile: path.join(output, "backend.cjs"), format: "cjs", platform: "node" });
for (const result of [frontend, backend]) for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith("src/") && !input.startsWith("node_modules/")) throw new Error(`Unexpected runtime input: ${input}`);
}
for (const file of ["manifest.json", "README.md", "LICENSE", "THIRD-PARTY.md"]) fs.copyFileSync(path.join(root, file), path.join(output, file));
fs.copyFileSync(path.join(root, "src/styles.css"), path.join(output, "styles.css"));
fs.mkdirSync(path.join(output, "licenses"));
fs.copyFileSync(path.join(root, "node_modules/html-to-image/LICENSE"), path.join(output, "licenses/html-to-image-LICENSE"));
console.log(`Built Drawing Pad plugin only: ${output}`);
