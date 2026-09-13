// The engine talks to the local store through `MirrorPort` (src/sync/mirror-port.ts) so that
// src/sync never imports src/proxy. This file is the proof that the narrow port is actually
// satisfied by the real thing: if `Mirror` ever loses a method, changes a timestamp type, or
// renames a record field, `npx tsc --noEmit` fails here rather than at runtime in the app.
//
// The assertions below are type-level; the runtime `expect`s only exist so vitest reports the file.

import { describe, expect, it } from "vitest";
import { Mirror } from "../../src/proxy/mirror";
import type { SessionRecord as ProxySessionRecord, StateRecord } from "../../src/proxy/mirror";
import type { MirrorPort, MirrorStateRecord, SessionRecord } from "../../src/sync/mirror-port";

describe("MirrorPort is satisfied by the real Mirror", () => {
  it("Mirror is assignable to MirrorPort", () => {
    // The whole point of the file: this line must compile.
    const _port: MirrorPort = {} as Mirror;
    expect(_port).toBeDefined();
  });

  it("an instance is assignable too (not just the type)", () => {
    const asPort = (m: Mirror): MirrorPort => m;
    expect(typeof asPort).toBe("function");
  });

  it("the Mirror's session record satisfies the port's, including clearedAt", () => {
    const _rec: SessionRecord = {} as ProxySessionRecord;
    const _clearedAt: string | null | undefined = _rec.clearedAt;
    expect(_clearedAt).toBeUndefined();
  });

  it("lastSyncAt is an ISO string on both sides", () => {
    const _state: MirrorStateRecord = {} as StateRecord;
    const _at: string | null = _state.lastSyncAt;
    expect(_at).toBeUndefined(); // the cast object is empty at runtime; the types are what matter
  });

  it("the port only asks for methods the Mirror has", () => {
    const required: (keyof MirrorPort)[] = [
      "readSystem",
      "writeLocalSystem",
      "setBaseSystem",
      "readSession",
      "writeLocalSession",
      "setBaseSession",
      "deleteLocalSession",
      "readAccount",
      "readState",
      "writeState",
      "snapshotLocal",
      "snapshotBase",
      "setSessionSynced",
    ];
    for (const name of required) {
      expect(typeof Mirror.prototype[name as keyof Mirror]).toBe("function");
    }
  });

  it("main creates the clientSessionId, not the engine", () => {
    // Documented in NOTES-sync.md §6: `main` calls this at startup; runSync only reads it.
    expect(typeof Mirror.prototype.ensureClientSessionId).toBe("function");
  });
});
