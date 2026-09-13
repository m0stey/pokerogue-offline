// Tells us when a newer game build has been published. That is all it does.
//
// It used to download, verify, unpack and swap in new game files. That was cut on 2026-09-13
// (DECISIONS.md, the scope trim): for one user on one laptop, a ~600 MB self-update is a lot of
// moving parts — staging folders, resumable downloads, checksum handling, a rename dance at
// startup, a "previous" copy to roll back to — guarding a path that had never once run for real.
// Every one of those parts can leave the game files broken, which is the one thing that must not
// happen. A new version now arrives the same way the first one did: a new installer, run once.
//
// So what is left is a notice. At most one look at the release feed every six hours, only while
// online, and if there is something newer than what we serve, one plain German message telling the user
// to ask for the new installation. Nothing is downloaded and nothing on disk is touched.

import { join } from "node:path";
import { get as httpsGet } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Logger } from "../common/log";
import { compareGameVersion } from "../common/version";
import type { Connectivity } from "./contracts";
import { readJsonSafe, writeJsonAtomic } from "./settings";

/**
 * GitHub repository that publishes the game builds (decided 2026-09-12).
 * Releases are named `game-<tag>`, e.g. `game-v1.12.0.11`.
 */
export const UPDATE_REPO = "m0stey/pokerogue-offline";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // 6 hours
const TIMER_TICK_MS = 30 * 60 * 1000; // look at the clock every 30 min
const USER_AGENT = `PokeRogueOffline/0.1 (+https://github.com/${UPDATE_REPO})`;
const NET_TIMEOUT_MS = 30_000;

interface UpdateState {
  lastCheckAt: number;
}

const EMPTY_STATE: UpdateState = { lastCheckAt: 0 };

export interface UpdaterDeps {
  userDataDir: string;
  log: Logger;
  connectivity: Connectivity;
  /** The release tag we are serving right now (from version.json), or null when unknown. */
  installedTag: () => string | null;
  /** Show the "there is a new version, ask for the new installation" notice. At most once. */
  onNewerVersion: (info: { latestTag: string; installedTag: string }) => void;
  /** Only for tests: skip the real network. */
  fetchJson?: (url: string) => Promise<unknown>;
}

export class Updater {
  private readonly stateFile: string;
  private state: UpdateState;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: UpdaterDeps) {
    this.stateFile = join(deps.userDataDir, "update-state.json");
    this.state = { ...EMPTY_STATE, ...readJsonSafe<Partial<UpdateState>>(this.stateFile, {}) };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.maybeCheck("timer"), TIMER_TICK_MS);
    if (this.timer.unref) this.timer.unref();
    void this.maybeCheck("startup");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Respects the six hour spacing and the online state. */
  async maybeCheck(reason: string): Promise<void> {
    if (this.deps.connectivity.state !== "online") return;
    if (Date.now() - this.state.lastCheckAt < CHECK_EVERY_MS) return;
    await this.checkNow(reason);
  }

  /** Ignores the six hour spacing. */
  async checkNow(reason: string): Promise<void> {
    if (this.running) return;
    if (this.deps.connectivity.state !== "online") return;
    this.running = true;
    try {
      // Written before the check runs, so a failing check uses up its slot instead of looping.
      this.patch({ lastCheckAt: Date.now() });
      const latest = await this.latestTag();
      const installed = this.deps.installedTag();
      this.deps.log.info("looked for a game update", { reason, latest, installed });
      if (!latest || !installed) return;
      if (compareTags(latest, installed) !== 1) return;
      this.deps.onNewerVersion({ latestTag: latest, installedTag: installed });
    } catch (err) {
      // A feed we cannot read is never worth a message: the user just keeps playing.
      this.deps.log.warn("the update check did not work", { reason, error: String(err) });
    } finally {
      this.running = false;
    }
  }

  private async latestTag(): Promise<string | null> {
    const url = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`;
    const fetcher = this.deps.fetchJson ?? fetchJson;
    const releases = (await fetcher(url)) as GithubRelease[] | null;
    if (!Array.isArray(releases)) return null;
    for (const r of releases) {
      if (r.draft || r.prerelease) continue;
      const tag = gameTag(r);
      if (tag) return tag;
    }
    return null;
  }

  private patch(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    try {
      writeJsonAtomic(this.stateFile, this.state);
    } catch (err) {
      this.deps.log.warn("could not remember the update state", { error: String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported so tests can reach them without an Electron app)
// ---------------------------------------------------------------------------

interface GithubRelease {
  name?: string | null;
  tag_name?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

/** Releases are named `game-<tag>`; the tag is what version.json carries. */
export function gameTag(release: { name?: string | null; tag_name?: string | null }): string | null {
  for (const candidate of [release.tag_name, release.name]) {
    if (typeof candidate === "string" && candidate.startsWith("game-")) {
      const tag = candidate.slice("game-".length).trim();
      if (tag) return tag;
    }
  }
  return null;
}

/**
 * Compare two release tags (`v1.12.0.11`) with the same rule the game server uses for versions.
 * Returns -1/0/1, or `null` when either side is not a plain `x.y.z[.w]` — in which case the caller
 * must say nothing, because a wrong "there is a new version" message sends the user looking for an
 * installer that does not exist.
 */
export function compareTags(a: string, b: string): number | null {
  const strip = (t: string): string => (t.startsWith("v") || t.startsWith("V") ? t.slice(1) : t);
  return compareGameVersion(strip(a.trim()), strip(b.trim()));
}

// ---------------------------------------------------------------------------
// Tiny HTTPS helper (Node built-ins only)
// ---------------------------------------------------------------------------

function httpsRequest(url: string, headers: Record<string, string>, redirects = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...headers } }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirects > 0) {
        res.resume();
        httpsRequest(new URL(location, url).toString(), headers, redirects - 1).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.setTimeout(NET_TIMEOUT_MS, () => req.destroy(new Error("the connection timed out")));
    req.on("error", reject);
  });
}

export async function fetchText(url: string): Promise<string> {
  const res = await httpsRequest(url, {});
  if ((res.statusCode ?? 0) >= 400) {
    res.resume();
    throw new Error(`status ${res.statusCode} for ${url}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchJson(url: string): Promise<unknown> {
  return JSON.parse(await fetchText(url)) as unknown;
}
