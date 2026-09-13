// Live contract test against api.pokerogue.net.
//
// SKIPPED unless LIVE=1. It uses ONLY the throwaway account created for this project
// (scratch/api-probe/throwaway-account.json) and makes at most 8 requests, at least 1 s apart.
//
//   run:  LIVE=1 npx vitest run test/sync/live.test.ts
//
// What it proves: the request shapes in HttpUpstreamApi are accepted by the real server, a system
// save round-trips structurally, and the monotone-playtime rule behaves as documented.

import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { firstDifference, systemEquals } from "../../src/sync/compare";
import { HttpUpstreamApi } from "../../src/sync/upstream-api";
import type { SystemSave } from "../../src/sync/types";

const CREDS_PATH = "C:/dev/pokerogue-offline/scratch/api-probe/throwaway-account.json";
const LIVE = process.env["LIVE"] === "1";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every live call is spaced by at least a second. */
const paced = async <T>(fn: () => Promise<T>): Promise<T> => {
  const out = await fn();
  await wait(1100);
  return out;
};

/** Same shape as the client's: 32 url-safe characters. */
function newClientSessionId(): string {
  return randomBytes(24).toString("base64url").slice(0, 32);
}

describe.runIf(LIVE)("live contract (LIVE=1)", () => {
  it(
    "logs in, reads the system save, pushes playTime + 1, and reads it back unchanged",
    async () => {
      expect(existsSync(CREDS_PATH), `throwaway credentials at ${CREDS_PATH}`).toBe(true);
      const creds = JSON.parse(readFileSync(CREDS_PATH, "utf8")) as {
        username: string;
        password: string;
      };
      // Guard: this test must never touch anything but the throwaway probe account.
      expect(creds.username.startsWith("offsync_")).toBe(true);

      const api = new HttpUpstreamApi();
      const csid = newClientSessionId();

      // 1. login
      const login = await paced(() => api.login(creds.username, creds.password));
      expect(login.ok, `login failed: ${JSON.stringify(login)}`).toBe(true);
      if (!login.ok) {
        return;
      }
      expect(login.data.token).toMatch(/^[A-Za-z0-9+/]{43}=$/);

      // 2. system/get — this also claims the clientSessionId
      const before = await paced(() => api.getSystem(csid));
      expect(before.ok, `system/get failed: ${JSON.stringify(before)}`).toBe(true);
      if (!before.ok || before.data === null) {
        throw new Error("the throwaway account has no system save to work with");
      }
      const stored = before.data;
      const storedPlayTime = (stored.gameStats as { playTime: number }).playTime;
      expect(typeof storedPlayTime).toBe("number");

      // 3. system/update with playTime + 1 and the SAME trainerId/secretId
      const next: SystemSave = {
        ...stored,
        gameStats: { ...(stored.gameStats as Record<string, unknown>), playTime: storedPlayTime + 1 },
      } as SystemSave;
      expect(next.trainerId).toBe(stored.trainerId);
      expect(next.secretId).toBe(stored.secretId);

      const update = await paced(() => api.updateSystem(csid, next));
      expect(update.ok, `system/update failed: ${JSON.stringify(update)}`).toBe(true);
      expect(update.status).toBe(204); // documented: system update answers 204, empty body

      // 4. system/get again and compare structurally
      const after = await paced(() => api.getSystem(csid));
      expect(after.ok).toBe(true);
      if (!after.ok) {
        return;
      }
      expect(after.status).toBe(200);
      const got = after.data as SystemSave;
      expect((got.gameStats as { playTime: number }).playTime).toBe(storedPlayTime + 1);
      expect(
        systemEquals(got, next),
        `round trip differed at ${firstDifference(got, next)}`,
      ).toBe(true);
    },
    120_000,
  );
});

describe.runIf(!LIVE)("live contract", () => {
  it("is skipped without LIVE=1", () => {
    expect(LIVE).toBe(false);
  });
});
