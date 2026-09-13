// Bundles the Electron main process with esbuild. Renderer pages in src/ui are copied as-is.
import { build } from "esbuild";
import { cpSync, mkdirSync, existsSync, rmSync } from "node:fs";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
};

mkdirSync("dist/main", { recursive: true });
await build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.js" });

// Preload for our own small pages (conflict, settings). The game itself runs without a preload.
await build({ ...common, entryPoints: ["src/main/preload-ui.ts"], outfile: "dist/main/preload-ui.js" });

// src/main/wiring.ts is the only file that imports src/proxy and src/sync. It must build: without
// dist/main/wiring.js the app has no game server and refuses to start.
if (existsSync("src/main/wiring.ts")) {
  try {
    await build({ ...common, entryPoints: ["src/main/wiring.ts"], outfile: "dist/main/wiring.js", logLevel: "silent" });
    console.log("wiring ok (real proxy + sync are in)");
  } catch {
    rmSync("dist/main/wiring.js", { force: true });
    rmSync("dist/main/wiring.js.map", { force: true });
    console.error("wiring FAILED to build - the app will not start without it");
    process.exitCode = 1;
  }
}

if (existsSync("src/ui")) cpSync("src/ui", "dist/ui", { recursive: true });
console.log("build ok");
