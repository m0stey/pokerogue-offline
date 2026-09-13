// THE ONLY FILE IN src/main THAT TOUCHES src/proxy AND src/sync.
//
// It is bundled separately (see scripts/build.mjs). dist/main/wiring.js is required: if it is
// missing, index.ts shows the start-up error and exits rather than running a game that cannot save.
//
// The casts below are deliberate and are the whole point of the adapter: the real classes have
// private members and slightly wider option objects, so they are not structurally assignable to
// the narrow interfaces in contracts.ts. Every mismatch between DESIGN.md and an implementation
// shows up here, in one place, instead of across src/main.

import { Connectivity as RealConnectivity } from "../proxy/connectivity";
import { Mirror as RealMirror } from "../proxy/mirror";
import { startProxy as realStartProxy } from "../proxy/server";
import { createBackupManager } from "../sync/backup";
import { runSync as realRunSync } from "../sync/engine";
import { HttpUpstreamApi } from "../sync/upstream-api";
import type { BackupManager, Connectivity, Mirror, RunSync, RuntimeDeps, StartProxy, UpstreamApi } from "./contracts";

export function loadRuntime(): RuntimeDeps {
  return {
    makeMirror: (dir, opts) => new RealMirror(dir, opts) as unknown as Mirror,

    makeConnectivity: (log, forceOfflineCheck) =>
      new RealConnectivity({ log, forceOfflineCheck }) as unknown as Connectivity,

    startProxy: realStartProxy as unknown as StartProxy,

    makeBackupManager: (opts) =>
      createBackupManager({
        documentsDir: opts.documentsDir,
        userDataDir: opts.userDataDir,
        log: opts.log,
      }) as unknown as BackupManager,

    // The token comes from the mirror's account record, which the proxy fills in on login.
    makeUpstreamApi: (opts) => new HttpUpstreamApi({ token: opts.token, log: opts.log }) as unknown as UpstreamApi,

    runSync: realRunSync as unknown as RunSync,
  };
}
