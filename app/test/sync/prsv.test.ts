import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRSV_KEY,
  PrsvError,
  SYSTEM_SAVE_SHORT_KEY_MAP,
  decodeBypassBlob,
  decryptPrsv,
  encodeBypassBlob,
  encryptPrsv,
  expandSystemDataStr,
  shortenSystemDataStr,
  tryDecryptPrsv,
} from "../../src/sync/prsv";

const FIXTURES = join(__dirname, "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("prsv crypto", () => {
  it("uses the key that is public in upstream src/constants.ts", () => {
    expect(PRSV_KEY).toBe("x0i2O7WRiANTqPmZ");
  });

  it("decrypts a blob produced by the real crypto-js@4.2.0 (tiny)", () => {
    expect(decryptPrsv(read("tiny.cryptojs.prsv"))).toBe(read("tiny.json"));
  });

  it("decrypts a real system export produced by crypto-js", () => {
    const plain = decryptPrsv(read("system-final.cryptojs.prsv"));
    expect(plain).toBe(read("system-final.shortened.json"));
    expect(JSON.parse(expandSystemDataStr(plain))).toEqual(JSON.parse(read("system-final.json")));
  });

  it("decrypts a real session export produced by crypto-js", () => {
    const plain = decryptPrsv(read("session-roundtrip.cryptojs.prsv"));
    expect(JSON.parse(plain)).toEqual(JSON.parse(read("session-roundtrip.json")));
  });

  it("produces the OpenSSL 'Salted__' envelope CryptoJS expects", () => {
    const blob = encryptPrsv('{"a":1}');
    const raw = Buffer.from(blob, "base64");
    expect(raw.subarray(0, 8).toString("latin1")).toBe("Salted__");
    // magic(8) + salt(8) + at least one AES block
    expect(raw.length).toBeGreaterThanOrEqual(32);
    expect((raw.length - 16) % 16).toBe(0);
  });

  it("is deterministic for a fixed salt and matches the fixture byte-for-byte", () => {
    const fixture = read("tiny.cryptojs.prsv").trim();
    const salt = Buffer.from(fixture, "base64").subarray(8, 16);
    expect(encryptPrsv(read("tiny.json"), salt)).toBe(fixture);
  });

  it("round-trips unicode and a large save", () => {
    const big = read("system-final.json");
    expect(decryptPrsv(encryptPrsv(big))).toBe(big);
    const uni = JSON.stringify({ s: "héllo ☃ \u{1F600}" });
    expect(decryptPrsv(encryptPrsv(uni))).toBe(uni);
  });

  it("uses a fresh random salt each time", () => {
    const a = encryptPrsv('{"a":1}');
    const b = encryptPrsv('{"a":1}');
    expect(a).not.toBe(b);
    expect(decryptPrsv(a)).toBe(decryptPrsv(b));
  });

  describe("rejects garbage cleanly", () => {
    const cases: [string, string, string][] = [
      ["empty string", "", "empty"],
      ["whitespace only", "   \n ", "empty"],
      ["not base64", "this is not base64!!", "not-base64"],
      ["odd base64 length", "U2FsdGVkX1", "not-base64"],
      ["valid base64 but too short", Buffer.from("hello").toString("base64"), "too-short"],
      [
        "valid base64, right length, wrong magic",
        Buffer.concat([Buffer.from("NotSalt_"), Buffer.alloc(24)]).toString("base64"),
        "bad-magic",
      ],
      [
        "correct magic but ciphertext is not a whole block",
        Buffer.concat([Buffer.from("Salted__"), Buffer.alloc(8), Buffer.alloc(17)]).toString("base64"),
        "bad-block-size",
      ],
    ];
    for (const [name, input, kind] of cases) {
      it(name, () => {
        expect(() => decryptPrsv(input)).toThrowError(PrsvError);
        try {
          decryptPrsv(input);
        } catch (e) {
          expect((e as PrsvError).kind).toBe(kind);
        }
      });
    }

    it("rejects a well-formed envelope encrypted with a different key", () => {
      // Random ciphertext: padding will be wrong (or the plaintext will not be UTF-8).
      const raw = Buffer.concat([Buffer.from("Salted__"), Buffer.alloc(8, 7), Buffer.alloc(64, 9)]);
      expect(() => decryptPrsv(raw.toString("base64"))).toThrowError(PrsvError);
    });

    it("rejects a bypass-mode localStorage blob (which is what the game's zip export writes)", () => {
      expect(() => decryptPrsv(encodeBypassBlob('{"a":1}'))).toThrowError(PrsvError);
    });

    it("tryDecryptPrsv returns null instead of throwing", () => {
      expect(tryDecryptPrsv("nope")).toBeNull();
      expect(tryDecryptPrsv(encryptPrsv("{}"))).toBe("{}");
    });

    it("never throws a non-PrsvError for arbitrary input", () => {
      const inputs = ["", "a", "====", "U2FsdGVkX18=", "U2FsdGVkX1/R90NYhtvHUg==", "🙂"];
      for (const i of inputs) {
        try {
          decryptPrsv(i);
        } catch (e) {
          expect(e).toBeInstanceOf(PrsvError);
        }
      }
    });
  });
});

describe("bypass blobs", () => {
  it("round-trips", () => {
    const json = JSON.stringify({ a: 1, s: "wörld ☃" });
    expect(decodeBypassBlob(encodeBypassBlob(json))).toBe(json);
  });

  it("matches btoa(encodeURIComponent(x))", () => {
    expect(encodeBypassBlob("{}")).toBe(Buffer.from(encodeURIComponent("{}"), "latin1").toString("base64"));
  });

  it("rejects malformed input with a PrsvError", () => {
    expect(() => decodeBypassBlob("")).toThrowError(PrsvError);
    expect(() => decodeBypassBlob("!!!")).toThrowError(PrsvError);
    expect(() => decodeBypassBlob(Buffer.from("%zz").toString("base64"))).toThrowError(PrsvError);
  });
});

describe("system key shortening", () => {
  it("has exactly the upstream map", () => {
    expect(SYSTEM_SAVE_SHORT_KEY_MAP).toEqual({
      seenAttr: "$sa",
      caughtAttr: "$ca",
      natureAttr: "$na",
      seenCount: "$s",
      caughtCount: "$c",
      hatchedCount: "$hc",
      ivs: "$i",
      moveset: "$m",
      eggMoves: "$em",
      candyCount: "$x",
      friendship: "$f",
      abilityAttr: "$a",
      passiveAttr: "$pa",
      valueReduction: "$vr",
      classicWinCount: "$wc",
    });
  });

  it("reproduces the client's shortened plaintext byte-for-byte", () => {
    const original = read("system-final.json");
    const ids = JSON.parse(original) as { trainerId: number; secretId: number };
    expect(shortenSystemDataStr(original, ids)).toBe(read("system-final.shortened.json"));
  });

  it("expands back to the original", () => {
    expect(expandSystemDataStr(read("system-final.shortened.json"))).toBe(read("system-final.json"));
  });

  it("expands the legacy $pAttr key the way importData does", () => {
    expect(expandSystemDataStr('{"$pAttr":1}')).toBe('{"passiveAttr":1}');
  });

  it("rewrites trainerId/secretId when ids are supplied, and leaves them alone otherwise", () => {
    const src = '{"trainerId":1,"secretId":2}';
    expect(shortenSystemDataStr(src, { trainerId: 9, secretId: 8 })).toBe('{"trainerId":9,"secretId":8}');
    expect(shortenSystemDataStr(src)).toBe(src);
  });

  it("orders replacements so $sa is expanded before $s", () => {
    expect(expandSystemDataStr('{"$sa":1,"$s":2,"$ca":3,"$c":4}')).toBe(
      '{"seenAttr":1,"seenCount":2,"caughtAttr":3,"caughtCount":4}',
    );
  });

  it("is what a .prsv system export contains", () => {
    const original = read("system-final.json");
    const ids = JSON.parse(original) as { trainerId: number; secretId: number };
    const blob = encryptPrsv(shortenSystemDataStr(original, ids));
    expect(JSON.parse(expandSystemDataStr(decryptPrsv(blob)))).toEqual(JSON.parse(original));
  });
});
