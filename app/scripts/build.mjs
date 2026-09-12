// Bundles the Electron main process with esbuild. Renderer pages in src/ui are copied as-is.
import { build } from "esbuild";
import { cpSync, mkdirSync, existsSync } from "node:fs";

mkdirSync("dist/main", { recursive: true });
await build({
  entryPoints: ["src/main/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/main/index.js",
  external: ["electron"],
  sourcemap: true,
});
if (existsSync("src/ui")) cpSync("src/ui", "dist/ui", { recursive: true });
console.log("build ok");
