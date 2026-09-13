// The two switches that exist only so a developer can exercise the app, kept in one small pure
// module so a test can prove they are dead in a packaged build.
//
// Neither of them is dangerous on its own — one makes the app behave as if there were no network,
// the other opens the developer tools — but both are ways for someone who is not her to change what
// the app does, and the shipped build should have neither.

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Development only: touch `<userData>/force-offline` to make the app behave as if there is no
 * network. A packaged build gets `undefined`, so the file can sit there and mean nothing and there
 * is no way for her to end up stuck offline.
 */
export const FORCE_OFFLINE_FILE = "force-offline";

export function forceOfflineCheck(opts: {
  isPackaged: boolean;
  userDataDir: string;
  /** Injected for tests. */
  fileExists?: (file: string) => boolean;
}): (() => boolean) | undefined {
  if (opts.isPackaged) {
    return undefined;
  }
  const exists = opts.fileExists ?? existsSync;
  const file = join(opts.userDataDir, FORCE_OFFLINE_FILE);
  return () => exists(file);
}

/** F12 opens the developer tools in a development build, and does nothing in a packaged one. */
export function devToolsAllowed(isPackaged: boolean): boolean {
  return !isPackaged;
}
