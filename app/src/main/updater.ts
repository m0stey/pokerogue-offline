// Keeps the app and the game up to date by itself.
//
// On every start (and every six hours while online) the app compares its own version with the
// newest release on GitHub. If the release is newer, it downloads it straight away and shows a small
// window with the progress; the user can keep playing meanwhile. When the download is verified, one click
// restarts PokeRogue into the new version (closing the game does the same).
//
// One mechanism for everything: every release carries a complete installer (app + game). Updating
// means downloading that installer, checking it against its published SHA-256, and running it
// silently after the app has closed. The installer replaces the program folder only; saves, backups
// and settings live in %APPDATA% and Documents and are never touched. If the download breaks,
// nothing on disk changes at all.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { get as httpsGet } from "node:https";
import type { IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Logger } from "../common/log";
import { compareGameVersion } from "../common/version";
import type { Connectivity } from "./contracts";
import { readJsonSafe, writeJsonAtomic } from "./settings";

/** GitHub repository that publishes the releases (decided 2026-09-12). */
export const UPDATE_REPO = "m0stey/pokerogue-offline";

/** Asset names every release must carry (see .github/workflows/release.yml). */
export const INSTALLER_ASSET = "PokeRogue-Setup.exe";
export const CHECKSUM_ASSET = "PokeRogue-Setup.exe.sha256";
export const RELEASE_INFO_ASSET = "release.json";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const TIMER_TICK_MS = 10 * 60 * 1000;
const NET_TIMEOUT_MS = 60_000;
const USER_AGENT = `PokeRogueOffline (+https://github.com/${UPDATE_REPO})`;
const MIN_INSTALLER_BYTES = 50 * 1024 * 1024;
/** Downloads may only come from GitHub. Redirects anywhere else are refused. */
const ALLOWED_HOSTS = [/^github\.com$/, /^api\.github\.com$/, /(^|\.)githubusercontent\.com$/];

export interface ReleaseInfo {
  gameTag: string;
  appVersion: string;
}

export interface AvailableUpdate extends ReleaseInfo {
  releaseTag: string;
  installerUrl: string;
  checksumUrl: string;
  sizeBytes: number;
}

export interface InstalledVersion {
  gameTag: string | null;
  appVersion: string;
}

export type StreamOpener = (url: string) => Promise<IncomingMessage>;

export interface UpdaterDeps {
  userDataDir: string;
  log: Logger;
  connectivity: Connectivity;
  installed: () => InstalledVersion;
  /** A newer release exists. Called at most once per app start. */
  onUpdateAvailable: (update: AvailableUpdate) => void;
  /** Only for tests. */
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
  openStream?: StreamOpener;
  now?: () => number;
}

interface UpdateState {
  lastCheckAt: number;
}

export class Updater {
  private readonly stateFile: string;
  private readonly updatesDir: string;
  private state: UpdateState;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<AvailableUpdate | null> | null = null;
  /** The first successful look after start happens regardless of when the last one was. */
  private checkedThisRun = false;
  private announced = false;
  private downloading: Promise<string> | null = null;
  private ready: string | null = null;

  constructor(private readonly deps: UpdaterDeps) {
    this.stateFile = join(deps.userDataDir, "update-state.json");
    this.updatesDir = join(deps.userDataDir, "updates");
    this.state = { lastCheckAt: 0, ...readJsonSafe<Partial<UpdateState>>(this.stateFile, {}) };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Checks right away (on start, when online) and then every six hours. */
  start(): void {
    if (this.timer) return;
    this.cleanupOldDownloads();
    this.timer = setInterval(() => void this.maybeCheck("timer"), TIMER_TICK_MS);
    this.timer.unref?.();
    void this.checkNow("startup");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Respects the six hour spacing. Used by the timer and when the connection comes back. */
  async maybeCheck(reason: string): Promise<AvailableUpdate | null> {
    if (this.checkedThisRun && this.now() - this.state.lastCheckAt < CHECK_EVERY_MS) return null;
    return this.checkNow(reason);
  }

  /**
   * Looks right away. A call made while a look is already running waits for that one and gets its
   * answer, so "nothing found" is never reported just because two checks overlapped.
   */
  checkNow(reason: string): Promise<AvailableUpdate | null> {
    if (this.inflight) return this.inflight;
    if (this.announced || this.deps.connectivity.state !== "online") return Promise.resolve(null);
    this.checkedThisRun = true;
    this.inflight = this.runCheck(reason).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runCheck(reason: string): Promise<AvailableUpdate | null> {
    try {
      this.patch({ lastCheckAt: this.now() });
      const update = await this.findUpdate();
      this.deps.log.info("looked for an update", { reason, found: update?.releaseTag ?? null, installed: this.deps.installed() });
      if (update && !this.announced) {
        this.announced = true;
        this.deps.onUpdateAvailable(update);
      }
      return update;
    } catch (err) {
      // A feed we cannot read is never worth a message: the user just keeps playing.
      this.deps.log.warn("the update check did not work", { reason, error: String(err) });
      return null;
    }
  }

  async findUpdate(): Promise<AvailableUpdate | null> {
    const getJson = this.deps.fetchJson ?? fetchJson;
    const candidate = pickRelease(await getJson(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`));
    if (!candidate) return null;
    const info = parseReleaseInfo(await getJson(candidate.infoUrl));
    if (!info || !isNewer(info, this.deps.installed())) return null;
    return { ...info, ...candidate };
  }

  /** Downloads and verifies the installer; resolves with its path. Calling it twice is harmless. */
  download(update: AvailableUpdate, onProgress?: (fraction: number) => void): Promise<string> {
    if (this.ready) return Promise.resolve(this.ready);
    if (!this.downloading) {
      this.downloading = this.doDownload(update, onProgress)
        .then((file) => (this.ready = file))
        .finally(() => (this.downloading = null));
    }
    return this.downloading;
  }

  /** True once a newer release was found and handed to onUpdateAvailable. */
  get updateFound(): boolean {
    return this.announced;
  }

  /** Path of a verified installer waiting to be run, if any. */
  get readyInstaller(): string | null {
    return this.ready;
  }

  private async doDownload(update: AvailableUpdate, onProgress?: (fraction: number) => void): Promise<string> {
    mkdirSync(this.updatesDir, { recursive: true });
    const expected = parseChecksum(await (this.deps.fetchText ?? fetchText)(update.checksumUrl));
    if (!expected) throw new Error("the release has no usable checksum");

    const final = join(this.updatesDir, `PokeRogue-Setup-${update.releaseTag.replace(/[^\w.-]/g, "_")}.exe`);
    if (existsSync(final) && (await sha256File(final)) === expected) return final;

    const part = `${final}.part`;
    rmSync(part, { force: true });
    const res = await (this.deps.openStream ?? openStream)(update.installerUrl);
    if ((res.statusCode ?? 0) !== 200) {
      res.resume();
      throw new Error(`download failed with status ${res.statusCode}`);
    }
    const total = Number(res.headers["content-length"]) || update.sizeBytes || 0;
    const hash = createHash("sha256");
    let received = 0;
    let lastPct = -1;
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(part);
      res.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        received += chunk.length;
        const pct = total > 0 ? Math.floor((received / total) * 100) : -1;
        if (onProgress && pct !== lastPct) {
          lastPct = pct;
          onProgress(Math.min(1, received / total));
        }
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("the download was interrupted")));
      out.on("error", reject);
      out.on("finish", resolve);
      res.pipe(out);
    });
    const actual = hash.digest("hex");
    if (received < MIN_INSTALLER_BYTES || (total > 0 && received !== total) || actual !== expected) {
      rmSync(part, { force: true });
      throw new Error(`the downloaded installer failed verification (bytes ${received}/${total})`);
    }
    renameSync(part, final);
    this.deps.log.info("update downloaded and verified", { file: final, bytes: received });
    return final;
  }

  /**
   * Arranges for the installer to run once this process has exited: a hidden PowerShell waits for
   * our PID, then starts the installer silently; `--force-run` starts PokeRogue again afterwards.
   * The caller quits the app right after (which still saves online first).
   */
  launchInstallerAfterExit(installer: string): void {
    const quoted = installer.replace(/'/g, "''");
    const script =
      `Wait-Process -Id ${process.pid} -Timeout 180 -ErrorAction SilentlyContinue; ` +
      `Start-Process -FilePath '${quoted}' -ArgumentList '/S','--updated','--force-run'`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    this.deps.log.info("the installer will run after the app closes", { installer });
  }

  private cleanupOldDownloads(): void {
    try {
      if (!existsSync(this.updatesDir)) return;
      for (const name of readdirSync(this.updatesDir)) {
        const file = join(this.updatesDir, name);
        const old = this.now() - statSync(file).mtimeMs > 7 * 24 * 60 * 60 * 1000;
        if (name.endsWith(".part") || old) rmSync(file, { force: true });
      }
    } catch (err) {
      this.deps.log.warn("could not tidy old update downloads", { error: String(err) });
    }
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
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

interface GithubAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}
interface GithubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubAsset[];
}

/** The newest published release that carries all three assets. */
export function pickRelease(
  releases: unknown,
): { releaseTag: string; installerUrl: string; checksumUrl: string; infoUrl: string; sizeBytes: number } | null {
  if (!Array.isArray(releases)) return null;
  for (const r of releases as GithubRelease[]) {
    if (!r || r.draft || r.prerelease || typeof r.tag_name !== "string") continue;
    const url = (name: string): string | null => {
      const a = r.assets?.find((x) => x.name === name);
      return a && typeof a.browser_download_url === "string" && isAllowedDownloadUrl(a.browser_download_url)
        ? a.browser_download_url
        : null;
    };
    const installerUrl = url(INSTALLER_ASSET);
    const checksumUrl = url(CHECKSUM_ASSET);
    const infoUrl = url(RELEASE_INFO_ASSET);
    if (!installerUrl || !checksumUrl || !infoUrl) continue;
    const size = r.assets?.find((x) => x.name === INSTALLER_ASSET)?.size;
    return { releaseTag: r.tag_name, installerUrl, checksumUrl, infoUrl, sizeBytes: typeof size === "number" ? size : 0 };
  }
  return null;
}

export function parseReleaseInfo(raw: unknown): ReleaseInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const { gameTag, appVersion } = raw as Record<string, unknown>;
  if (typeof gameTag !== "string" || typeof appVersion !== "string") return null;
  if (compareTags(gameTag, gameTag) === null || compareTags(appVersion, appVersion) === null) return null;
  return { gameTag, appVersion };
}

/**
 * Newer game wins; with the same game, a newer app wins. Never downgrades, and anything that does
 * not parse as a version counts as "not newer" so a broken feed can never trigger a download.
 */
export function isNewer(release: ReleaseInfo, installed: InstalledVersion): boolean {
  if (installed.gameTag) {
    const game = compareTags(release.gameTag, installed.gameTag);
    if (game === null) return false;
    if (game !== 0) return game === 1;
  }
  return compareTags(release.appVersion, installed.appVersion) === 1;
}

/** `v1.12.0.11` vs `1.12.0.12`, same rule as the game server. `null` when either is not a version. */
export function compareTags(a: string, b: string): number | null {
  const strip = (t: string): string => t.trim().replace(/^[vV]/, "");
  return compareGameVersion(strip(a), strip(b));
}

/** Accepts `<hex>` or `<hex>  filename`, as written by sha256sum. */
export function parseChecksum(text: string): string | null {
  const match = /\b([a-fA-F0-9]{64})\b/.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

export function isAllowedDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Network (Node built-ins only)
// ---------------------------------------------------------------------------

export function openStream(url: string, redirects = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (!isAllowedDownloadUrl(url)) {
      reject(new Error(`refusing to download from ${url}`));
      return;
    }
    const req = httpsGet(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*" } }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirects <= 0) return reject(new Error("too many redirects"));
        openStream(new URL(location, url).toString(), redirects - 1).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.setTimeout(NET_TIMEOUT_MS, () => req.destroy(new Error("the connection timed out")));
    req.on("error", reject);
  });
}

export async function fetchText(url: string): Promise<string> {
  const res = await openStream(url);
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

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
