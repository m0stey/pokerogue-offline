import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionSave, SystemSave } from "../../src/sync/types";

const created: string[] = [];

export function tempDir(prefix = "pokerogue-proxy-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (created.length > 0) {
    const dir = created.pop();
    if (!dir) {
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  raw: Buffer;
}

export function httpRequest(
  baseUrl: string,
  requestPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  const url = new URL(baseUrl);
  return new Promise<HttpResult>((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: requestPath,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: raw.toString("utf8"),
            raw,
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

export function makeSystem(overrides: Partial<SystemSave> = {}): SystemSave {
  return {
    trainerId: 60746,
    secretId: 44388,
    gender: 0,
    dexData: {},
    starterData: {},
    gameStats: { playTime: 1000, battles: 0 },
    unlocks: {},
    achvUnlocks: {},
    voucherUnlocks: {},
    voucherCounts: { "0": 0, "1": 0, "2": 0, "3": 0 },
    eggs: [],
    eggPity: [0, 0, 0, 0],
    unlockPity: [0, 0, 0, 0],
    gameVersion: "1.12.1.0",
    timestamp: 1789231606586,
    appliedMigrators: {},
    ...overrides,
  } as SystemSave;
}

export function withPlayTime(save: SystemSave, playTime: number): SystemSave {
  return {
    ...save,
    gameStats: { ...(save.gameStats as Record<string, unknown>), playTime },
  } as SystemSave;
}

export function makeSession(overrides: Partial<SessionSave> = {}): SessionSave {
  return {
    seed: "PROBESEED0001",
    waveIndex: 1,
    gameMode: 0,
    party: [],
    timestamp: 1789231606586,
    gameVersion: "1.12.1.0",
    playTime: 120,
    ...overrides,
  } as SessionSave;
}

export function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };
export const JSON_HEADERS = { "Content-Type": "application/json" };
