// Keeps the game files up to date, quietly.
//
// How it works:
//   * at most one look at the release feed every 6 hours, and only while online
//   * if Windows says this is a mobile connection, we ask first (once, if the user says "always")
//   * the download resumes where it stopped, so a dropped connection costs nothing
//   * the zip is checked against its SHA-256 before it is ever unpacked
//   * the new files are put in place at the NEXT start, never while the game is running
//   * the old version stays on disk until the new one has survived one full session
//
// Unzipping: we shell out to Windows' own `tar.exe` (bsdtar, present on Windows 10 1803+ and on
// every Windows 11), falling back to PowerShell's `Expand-Archive`. Reason: the archive is ~500 MB
// with tens of thousands of entries; a hand-written ZIP reader on top of `zlib.inflateRawSync`
// would have to get zip64, data descriptors and streaming right, and a bug there corrupts the game
// files silently. Both fallbacks ship with the OS, so this adds no dependency.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { get as httpsGet } from "node:https";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../common/log";
import type { Connectivity } from "./contracts";
import { gamePaths, looksLikeGameDir, readVersionTag } from "./game-files";
import type { MeteredAnswer } from "./dialogs";
import { formatSize } from "./format";
import { readJsonSafe, writeJsonAtomic, type SettingsStore } from "./settings";

/**
 * GitHub repository that publishes the game builds (decided 2026-09-12).
 * Releases are named `game-<tag>` and carry `game.zip`, `game.zip.sha256` and `version.json`.
 */
export const UPDATE_REPO = "m0stey/pokerogue-offline";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // 6 hours
const TIMER_TICK_MS = 30 * 60 * 1000; // look at the clock every 30 min
const USER_AGENT = "PokeRogueOffline/0.1 (+https://github.com/" + UPDATE_REPO + ")";
const NET_TIMEOUT_MS = 30_000;

interface UpdateState {
  lastCheckAt: number;
  /** Unpacked and verified, waiting to be put in place at the next start. */
  pendingTag: string | null;
  /** What is in `game/current` right now, as far as we know. */
  installedTag: string | null;
  /** What is in `game/previous`, kept as a way back. */
  previousTag: string | null;
  /** Full sessions played since `installedTag` was put in place. */
  sessionsSinceInstall: number;
}

const EMPTY_STATE: UpdateState = {
  lastCheckAt: 0,
  pendingTag: null,
  installedTag: null,
  previousTag: null,
  sessionsSinceInstall: 0,
};

export interface ReleaseInfo {
  tag: string;
  zipUrl: string;
  shaUrl: string | null;
  sizeBytes: number | null;
}

export interface UpdaterDeps {
  userDataDir: string;
  log: Logger;
  settings: SettingsStore;
  connectivity: Connectivity;
  /** The tag we are serving right now (from version.json), or null. */
  installedTag: () => string | null;
  /** Ask about a big download on a mobile connection. */
  askMetered: (sizeText: string) => Promise<MeteredAnswer>;
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

  // -------------------------------------------------------------------------
  // Startup / shutdown housekeeping
  // -------------------------------------------------------------------------

  /**
   * Put a downloaded update in place. Must run BEFORE the game server starts, because on Windows
   * a folder cannot be renamed while its files are open. Returns the tag now installed, if changed.
   */
  applyPendingUpdate(): string | null {
    const tag = this.state.pendingTag;
    if (!tag) return null;
    const paths = gamePaths(this.deps.userDataDir);
    const candidate = join(paths.staging, tag, "unpacked");
    if (!looksLikeGameDir(candidate)) {
      this.deps.log.warn("a downloaded update was incomplete and has been thrown away", { tag });
      this.patch({ pendingTag: null });
      rmSync(join(paths.staging, tag), { recursive: true, force: true });
      return null;
    }
    try {
      rmSync(paths.previous, { recursive: true, force: true });
      const previousTag = this.state.installedTag ?? readVersionTag(paths.current);
      if (existsSync(paths.current)) renameSync(paths.current, paths.previous);
      renameSync(candidate, paths.current);
      rmSync(join(paths.staging, tag), { recursive: true, force: true });
      this.patch({
        pendingTag: null,
        installedTag: tag,
        previousTag: previousTag ?? null,
        sessionsSinceInstall: 0,
      });
      this.deps.settings.update({ lastSeenGameTag: tag });
      this.deps.log.info("new game files are now in place", { tag, previousTag });
      return tag;
    } catch (err) {
      this.deps.log.error("could not put the new game files in place", { tag, error: String(err) });
      // Leave everything as it was; the old version still works.
      return null;
    }
  }

  /** Called once the app is up: the previous version can go if the new one has proven itself. */
  cleanupPreviousVersion(): void {
    if (this.state.sessionsSinceInstall < 1) return;
    const paths = gamePaths(this.deps.userDataDir);
    if (!existsSync(paths.previous)) return;
    try {
      rmSync(paths.previous, { recursive: true, force: true });
      this.patch({ previousTag: null });
      this.deps.log.info("removed the old game files - the new ones have been used for a whole session");
    } catch (err) {
      this.deps.log.warn("could not remove the old game files", { error: String(err) });
    }
  }

  /** Called when the app quits normally: the session counts as completed. */
  noteSessionCompleted(): void {
    this.patch({ sessionsSinceInstall: this.state.sessionsSinceInstall + 1 });
  }

  // -------------------------------------------------------------------------
  // Checking
  // -------------------------------------------------------------------------

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

  /** Respects the 6 hour spacing and the online state. */
  async maybeCheck(reason: string): Promise<void> {
    if (this.deps.connectivity.state !== "online") return;
    if (Date.now() - this.state.lastCheckAt < CHECK_EVERY_MS) return;
    await this.checkNow(reason);
  }

  /** Ignores the 6 hour spacing. Used by the "needs-game-update" signal from the save sync. */
  async checkNow(reason: string): Promise<void> {
    if (this.running) return;
    if (this.deps.connectivity.state !== "online") return;
    this.running = true;
    try {
      this.patch({ lastCheckAt: Date.now() });
      const release = await this.latestRelease();
      if (!release) return;
      const installed = this.deps.installedTag();
      this.deps.log.info("looked for a game update", { reason, latest: release.tag, installed });
      if (release.tag === installed || release.tag === this.state.pendingTag) return;

      if (!(await this.allowedToDownload(release))) return;
      await this.downloadAndStage(release);
    } catch (err) {
      // An update we cannot fetch is never worth a message: the user just keeps playing.
      this.deps.log.warn("the update check did not work", { reason, error: String(err) });
    } finally {
      this.running = false;
    }
  }

  private async allowedToDownload(release: ReleaseInfo): Promise<boolean> {
    const metered = await isMeteredConnection(this.deps.log);
    if (!metered) return true;
    const policy = this.deps.settings.get().allowMeteredDownloads;
    if (policy === "never") {
      this.deps.log.info("mobile connection: skipping the download as the user asked");
      return false;
    }
    if (policy === "always") return true;
    const answer = await this.deps.askMetered(formatSize(release.sizeBytes));
    if (answer.remember) {
      this.deps.settings.update({ allowMeteredDownloads: answer.download ? "always" : "never" });
    }
    return answer.download;
  }

  private async latestRelease(): Promise<ReleaseInfo | null> {
    const url = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`;
    const fetcher = this.deps.fetchJson ?? fetchJson;
    const releases = (await fetcher(url)) as GithubRelease[] | null;
    if (!Array.isArray(releases)) return null;
    const wantsPrereleases = this.deps.settings.get().gameUpdateChannel !== "stable";
    for (const r of releases) {
      if (r.draft) continue;
      if (r.prerelease && !wantsPrereleases) continue;
      const tag = gameTag(r);
      if (!tag) continue;
      const zip = (r.assets ?? []).find((a) => a.name === "game.zip");
      if (!zip) continue;
      const sha = (r.assets ?? []).find((a) => a.name === "game.zip.sha256");
      return {
        tag,
        zipUrl: zip.browser_download_url,
        shaUrl: sha?.browser_download_url ?? null,
        sizeBytes: typeof zip.size === "number" ? zip.size : null,
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Downloading
  // -------------------------------------------------------------------------

  private async downloadAndStage(release: ReleaseInfo): Promise<void> {
    const paths = gamePaths(this.deps.userDataDir);
    const dir = join(paths.staging, release.tag);
    mkdirSync(dir, { recursive: true });
    const zipFile = join(dir, "game.zip");

    this.deps.log.info("downloading new game files", { tag: release.tag });
    await downloadWithResume(release.zipUrl, zipFile, this.deps.log);

    if (release.shaUrl) {
      const expected = parseSha256File(await fetchText(release.shaUrl));
      const actual = await sha256File(zipFile);
      if (!expected || expected.toLowerCase() !== actual.toLowerCase()) {
        this.deps.log.error("the downloaded game files were damaged and have been thrown away", {
          tag: release.tag,
          expected,
          actual,
        });
        rmSync(dir, { recursive: true, force: true });
        return;
      }
    } else {
      this.deps.log.warn("the release has no checksum file; not installing it", { tag: release.tag });
      rmSync(dir, { recursive: true, force: true });
      return;
    }

    const unpacked = join(dir, "unpacked");
    rmSync(unpacked, { recursive: true, force: true });
    mkdirSync(unpacked, { recursive: true });
    await unzip(zipFile, unpacked, this.deps.log);

    const root = findGameRoot(unpacked);
    if (!root) {
      this.deps.log.error("the downloaded game files did not look right; ignoring them", { tag: release.tag });
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    if (root !== unpacked) {
      // The zip had a wrapper folder: lift it so `unpacked/` is the game itself.
      const lifted = join(dir, "unpacked-root");
      rmSync(lifted, { recursive: true, force: true });
      renameSync(root, lifted);
      rmSync(unpacked, { recursive: true, force: true });
      renameSync(lifted, unpacked);
    }
    rmSync(zipFile, { force: true });
    this.patch({ pendingTag: release.tag });
    this.deps.log.info("new game files are ready and will be used the next time the user starts the game", {
      tag: release.tag,
    });
  }

  // -------------------------------------------------------------------------

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

interface GithubAsset {
  name: string;
  size?: number;
  browser_download_url: string;
}

interface GithubRelease {
  name?: string | null;
  tag_name?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubAsset[];
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

export function parseSha256File(text: string): string | null {
  const match = /\b([a-fA-F0-9]{64})\b/.exec(text);
  return match ? (match[1] ?? null) : null;
}

/** The game root is the folder that holds index.html (top level, or one folder down). */
export function findGameRoot(dir: string): string | null {
  if (looksLikeGameDir(dir)) return dir;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && looksLikeGameDir(join(dir, entry.name))) return join(dir, entry.name);
    }
  } catch {
    /* nothing there */
  }
  return null;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Resumes a partial file with a Range request; falls back to starting over if the server says no. */
export async function downloadWithResume(url: string, file: string, log: Logger): Promise<void> {
  let from = 0;
  try {
    from = statSync(file).size;
  } catch {
    from = 0;
  }
  const res = await httpsRequest(url, from > 0 ? { Range: `bytes=${from}-` } : {});
  if (from > 0 && res.statusCode === 200) {
    log.info("the download had to start again from the beginning");
    from = 0;
  } else if (from > 0 && res.statusCode !== 206) {
    res.resume();
    throw new Error(`unexpected status ${res.statusCode} while resuming the download`);
  } else if (from === 0 && res.statusCode !== 200) {
    res.resume();
    throw new Error(`unexpected status ${res.statusCode} while downloading`);
  }
  mkdirSync(join(file, ".."), { recursive: true });
  await pipeline(res, createWriteStream(file, from > 0 ? { flags: "a" } : { flags: "w" }));
}

export async function unzip(zipFile: string, targetDir: string, log: Logger): Promise<void> {
  try {
    await run("tar.exe", ["-xf", zipFile, "-C", targetDir], 20 * 60_000);
    return;
  } catch (err) {
    log.warn("tar could not unpack the download, trying the slower way", { error: String(err) });
  }
  await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`,
    ],
    40 * 60_000,
  );
}

/**
 * Windows' view of the current connection. Anything we cannot read counts as "not metered",
 * because refusing to ever update is worse than one unexpected download.
 */
export async function isMeteredConnection(log: Logger): Promise<boolean> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$cost='';",
    "try {",
    "  $p=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetInternetConnectionProfile();",
    "  if ($p) { $cost=[string]$p.GetConnectionCost().NetworkCostType }",
    "} catch {}",
    "$cat=(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -eq 'Internet' -or $_.IPv6Connectivity -eq 'Internet' } | Select-Object -First 1 -ExpandProperty NetworkCategory);",
    "[pscustomobject]@{cost=[string]$cost;category=[string]$cat} | ConvertTo-Json -Compress",
  ].join(" ");
  try {
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 20_000);
    const parsed = JSON.parse(out.trim() || "{}") as { cost?: string; category?: string };
    // NetworkCostType: Unknown=0, Unrestricted=1, Fixed=2, Variable=3
    const cost = (parsed.cost ?? "").trim();
    const metered = cost === "Fixed" || cost === "Variable" || cost === "2" || cost === "3";
    log.info("checked what kind of connection this is", { cost, category: parsed.category ?? "", metered });
    return metered;
  } catch (err) {
    log.warn("could not tell what kind of connection this is; treating it as normal", { error: String(err) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tiny HTTPS helpers (Node built-ins only)
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

function run(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
