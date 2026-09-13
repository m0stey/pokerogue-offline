// The dev-only force-offline switch (DESIGN.md §5 testing hook): an injectable predicate that
// holds Connectivity offline and suppresses every upstream probe while it is true.

import { afterEach, describe, expect, it } from "vitest";
import { Connectivity } from "../../src/proxy/connectivity";
import type { ConnectivityChange } from "../../src/proxy/connectivity";
import { startFakeUpstream } from "./fake-upstream";
import type { FakeUpstream } from "./fake-upstream";

let fake: FakeUpstream | null = null;
let connectivity: Connectivity | null = null;

afterEach(async () => {
  connectivity?.stop();
  connectivity = null;
  await fake?.close();
  fake = null;
});

describe("Connectivity force-offline hook", () => {
  it("reports offline and makes no upstream request while the switch is on", async () => {
    fake = await startFakeUpstream();
    let forced = true;
    connectivity = new Connectivity({ baseUrl: fake.url, timeoutMs: 1000, forceOfflineCheck: () => forced });

    await connectivity.probe();
    expect(connectivity.state).toBe("offline");
    expect(connectivity.lastReason).toBe("forced-offline");
    expect(connectivity.isForcedOffline).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it("probes normally again once the switch goes away", async () => {
    fake = await startFakeUpstream();
    let forced = true;
    connectivity = new Connectivity({ baseUrl: fake.url, timeoutMs: 1000, forceOfflineCheck: () => forced });
    await connectivity.probe();
    expect(fake.requests).toHaveLength(0);

    forced = false;
    await connectivity.probe();
    expect(connectivity.state).toBe("online");
    expect(connectivity.isForcedOffline).toBe(false);
    expect(fake.requests).toHaveLength(1);
  });

  it("flips online -> offline -> online on its own timer, without restarting", async () => {
    fake = await startFakeUpstream();
    let forced = false;
    const changes: ConnectivityChange[] = [];
    connectivity = new Connectivity({
      baseUrl: fake.url,
      timeoutMs: 1000,
      onlineIntervalMs: 60_000,
      offlineIntervalMs: 60_000,
      forceOfflineCheck: () => forced,
      forceOfflineIntervalMs: 10,
    });
    connectivity.on("change", (c: ConnectivityChange) => changes.push(c));

    connectivity.start();
    await waitFor(() => connectivity?.state === "online", 3000);

    forced = true;
    await waitFor(() => connectivity?.state === "offline", 3000);
    const requestsWhileForced = fake.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.requests.length).toBe(requestsWhileForced); // no probing at all while forced

    forced = false;
    await waitFor(() => connectivity?.state === "online", 3000);
    expect(changes.map((c) => c.state)).toEqual(["online", "offline", "online"]);
    expect(changes[1]?.reason).toBe("forced-offline");
  });

  it("treats a throwing hook as 'not forced' and keeps probing", async () => {
    fake = await startFakeUpstream();
    connectivity = new Connectivity({
      baseUrl: fake.url,
      timeoutMs: 1000,
      forceOfflineCheck: () => {
        throw new Error("no file system today");
      },
    });
    await connectivity.probe();
    expect(connectivity.state).toBe("online");
    expect(fake.requests).toHaveLength(1);
  });

  it("stops its re-check timer with stop() and unrefs it", async () => {
    fake = await startFakeUpstream();
    connectivity = new Connectivity({
      baseUrl: fake.url,
      timeoutMs: 1000,
      forceOfflineCheck: () => false,
      forceOfflineIntervalMs: 10,
    });
    connectivity.start();
    await waitFor(() => connectivity?.state === "online", 3000);
    const timer = (connectivity as unknown as { forceTimer: NodeJS.Timeout | null }).forceTimer;
    expect(timer).not.toBeNull();
    expect(timer?.hasRef()).toBe(false);

    connectivity.stop();
    expect((connectivity as unknown as { forceTimer: NodeJS.Timeout | null }).forceTimer).toBeNull();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}
