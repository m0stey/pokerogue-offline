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

describe("Connectivity", () => {
  it("classifies a JSON 200 from titlestats as online and sends the Origin header", async () => {
    fake = await startFakeUpstream();
    connectivity = new Connectivity({ baseUrl: fake.url, timeoutMs: 1000 });
    expect(connectivity.state).toBe("unknown");

    const changes: ConnectivityChange[] = [];
    connectivity.on("change", (c: ConnectivityChange) => changes.push(c));

    await connectivity.probe();
    expect(connectivity.state).toBe("online");
    expect(connectivity.isOnline).toBe(true);
    expect(changes).toEqual([{ state: "online", previous: "unknown", reason: "probe-ok" }]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.path).toBe("/game/titlestats");
    expect(fake.requests[0]?.headers.origin).toBe("https://pokerogue.net");
  });

  it("classifies a Cloudflare text/html reply as offline", async () => {
    fake = await startFakeUpstream("html403");
    connectivity = new Connectivity({ baseUrl: fake.url, timeoutMs: 1000 });
    await connectivity.probe();
    expect(connectivity.state).toBe("offline");
    expect(connectivity.lastReason).toBe("probe-html");
  });

  it("classifies a transport error as offline", async () => {
    fake = await startFakeUpstream();
    const deadUrl = fake.url;
    await fake.close();
    fake = null;
    connectivity = new Connectivity({ baseUrl: deadUrl, timeoutMs: 1000 });
    await connectivity.probe();
    expect(connectivity.state).toBe("offline");
    expect(connectivity.lastReason).toMatch(/^probe-/);
  });

  it("classifies a hanging server as offline once the timeout elapses", async () => {
    fake = await startFakeUpstream("hang");
    connectivity = new Connectivity({ baseUrl: fake.url, timeoutMs: 120 });
    const started = Date.now();
    await connectivity.probe();
    expect(connectivity.state).toBe("offline");
    expect(connectivity.lastReason).toBe("probe-timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    fake = await startFakeUpstream();
    connectivity = new Connectivity({ baseUrl: fake.url, timeoutMs: 1000 });
    await Promise.all([connectivity.probe(), connectivity.probe(), connectivity.probe()]);
    expect(fake.requests).toHaveLength(1);
  });

  it("markOffline/markOnline emit a change only on a real transition", async () => {
    fake = await startFakeUpstream();
    connectivity = new Connectivity({ baseUrl: fake.url });
    const changes: ConnectivityChange[] = [];
    connectivity.on("change", (c: ConnectivityChange) => changes.push(c));

    connectivity.markOffline("upstream-html");
    connectivity.markOffline("upstream-html");
    connectivity.markOnline("upstream-responded");
    expect(changes.map((c) => c.state)).toEqual(["offline", "online"]);
    expect(connectivity.lastChangeAt).not.toBeNull();
  });

  it("polls on a timer that is unref'd and stops cleanly", async () => {
    fake = await startFakeUpstream();
    connectivity = new Connectivity({
      baseUrl: fake.url,
      timeoutMs: 500,
      onlineIntervalMs: 10,
      offlineIntervalMs: 10,
    });
    connectivity.start();
    await waitFor(() => fake !== null && fake.requests.length >= 3, 3000);

    const timer = (connectivity as unknown as { timer: NodeJS.Timeout | null }).timer;
    expect(timer).not.toBeNull();
    expect(timer?.hasRef()).toBe(false);

    connectivity.stop();
    const seen = fake.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.requests.length).toBeLessThanOrEqual(seen + 1);
    expect((connectivity as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}
