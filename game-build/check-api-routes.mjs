// Release guard: refuses to publish a game build that calls server routes nobody has reviewed.
//
// Offline, the app's proxy answers every route it does not know with 503. That is harmless for the
// routes listed in known-api-routes.json (reviewed: daily rankings, admin, account settings) but
// a new save-related route could break offline play the way `session/newclear` once did. Installed
// apps update themselves silently, so a new route must stop the release until someone has checked
// app/src/proxy/replay.ts and added it to the list.
//
// Usage: node game-build/check-api-routes.mjs <path to the upstream pokerogue checkout>

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const upstream = process.argv[2];
if (!upstream) {
  console.error("usage: node check-api-routes.mjs <pokerogue checkout>");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const known = new Set(JSON.parse(readFileSync(join(here, "known-api-routes.json"), "utf8")).routes);

const found = new Set();
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.ts$/.test(name)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/do(?:Get|Post)\(\s*[`"']\/([a-zA-Z0-9/_-]+)/g)) found.add("/" + m[1]);
    }
  }
};
walk(join(upstream, "src", "api"));

if (found.size === 0) {
  console.error("No API routes found - the upstream API layer changed shape. Review before releasing.");
  process.exit(1);
}
const unknown = [...found].filter((r) => !known.has(r)).sort();
console.log(`API routes in this game build: ${found.size}, unknown: ${unknown.length}`);
if (unknown.length > 0) {
  console.error("New server routes that the offline proxy has not been reviewed for:");
  for (const r of unknown) console.error("  " + r);
  console.error("Check app/src/proxy/replay.ts, then add them to game-build/known-api-routes.json.");
  process.exit(1);
}
