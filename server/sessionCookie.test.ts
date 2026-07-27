import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  LEGACY_SESSION_ID_RE,
  parseCookieHeader,
  resolveIncomingSessionId,
  signSessionId,
  verifySignedSessionId,
  SESSION_COOKIE_NAME,
} from "./_core/sessionCookie";

describe("parseCookieHeader", () => {
  it("parses a single cookie", () => {
    expect(parseCookieHeader("foo=bar")).toEqual({ foo: "bar" });
  });

  it("parses multiple cookies separated by '; '", () => {
    expect(parseCookieHeader("a=1; b=2; c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("returns an empty object for missing/empty header", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
  });

  it("decodes URI-encoded values", () => {
    expect(parseCookieHeader("x=a%2Eb")).toEqual({ x: "a.b" });
  });

  it("ignores malformed segments without '='", () => {
    expect(parseCookieHeader("garbage; a=1")).toEqual({ a: "1" });
  });
});

describe("signSessionId / verifySignedSessionId round trip", () => {
  it("verifies a freshly signed id and returns the original id", () => {
    const id = "abc123XYZ_-def456";
    const token = signSessionId(id);
    expect(verifySignedSessionId(token)).toBe(id);
  });

  it("rejects a tampered id (signature no longer matches)", () => {
    const token = signSessionId("original-id-value");
    const [, sig] = token.split(".");
    const tampered = `attacker-controlled-id.${sig}`;
    expect(verifySignedSessionId(tampered)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signSessionId("some-id-value-here");
    const [id] = token.split(".");
    expect(verifySignedSessionId(`${id}.not-the-real-signature`)).toBeNull();
  });

  it("rejects malformed tokens (no separator, empty parts)", () => {
    expect(verifySignedSessionId("no-dot-at-all")).toBeNull();
    expect(verifySignedSessionId(".leading-dot-only")).toBeNull();
    expect(verifySignedSessionId("trailing-dot-only.")).toBeNull();
    expect(verifySignedSessionId("")).toBeNull();
  });

  it("rejects null/undefined input", () => {
    expect(verifySignedSessionId(null)).toBeNull();
    expect(verifySignedSessionId(undefined)).toBeNull();
  });

  it("rejects a well-formed but never-issued token", () => {
    expect(verifySignedSessionId("some-random-id.some-random-signature-value")).toBeNull();
  });
});

describe("LEGACY_SESSION_ID_RE", () => {
  it("matches the old client-generated shape", () => {
    const example = `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    expect(LEGACY_SESSION_ID_RE.test(example)).toBe(true);
  });

  it("rejects arbitrary strings", () => {
    expect(LEGACY_SESSION_ID_RE.test("not-a-legacy-id")).toBe(false);
    expect(LEGACY_SESSION_ID_RE.test("session-abc-def")).toBe(false);
    expect(LEGACY_SESSION_ID_RE.test("")).toBe(false);
  });
});

describe("resolveIncomingSessionId", () => {
  it("prefers a valid signed cookie over everything else", async () => {
    const id = "existing-valid-session-id";
    const cookieHeader = `${SESSION_COOKIE_NAME}=${signSessionId(id)}`;
    const hasLegacyHistory = vi.fn(async () => true);

    const resolved = await resolveIncomingSessionId({
      cookieHeader,
      legacyHeader: "session-1700000000000-abc123def",
      hasLegacyHistory,
    });

    expect(resolved).toBe(id);
    expect(hasLegacyHistory).not.toHaveBeenCalled();
  });

  it("adopts a legacy id when no valid cookie is present and history exists", async () => {
    const legacyId = `session-${Date.now()}-abc123def`;
    const hasLegacyHistory = vi.fn(async (id: string) => id === legacyId);

    const resolved = await resolveIncomingSessionId({
      cookieHeader: undefined,
      legacyHeader: legacyId,
      hasLegacyHistory,
    });

    expect(resolved).toBe(legacyId);
    expect(hasLegacyHistory).toHaveBeenCalledWith(legacyId);
  });

  it("mints a brand new random id when there is no cookie, no legacy header", async () => {
    const hasLegacyHistory = vi.fn(async () => false);
    const a = await resolveIncomingSessionId({ cookieHeader: undefined, legacyHeader: null, hasLegacyHistory });
    const b = await resolveIncomingSessionId({ cookieHeader: undefined, legacyHeader: null, hasLegacyHistory });

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(30); // 256-bit base64url is well over 30 chars
    expect(hasLegacyHistory).not.toHaveBeenCalled();
  });

  it("mints a fresh id when the legacy header matches the shape but has no history", async () => {
    const legacyId = `session-${Date.now()}-nohistory1`;
    const hasLegacyHistory = vi.fn(async () => false);

    const resolved = await resolveIncomingSessionId({
      cookieHeader: undefined,
      legacyHeader: legacyId,
      hasLegacyHistory,
    });

    expect(resolved).not.toBe(legacyId);
    expect(hasLegacyHistory).toHaveBeenCalledWith(legacyId);
  });

  it("ignores a legacy header that doesn't match the expected shape at all", async () => {
    const hasLegacyHistory = vi.fn(async () => true);

    const resolved = await resolveIncomingSessionId({
      cookieHeader: undefined,
      legacyHeader: "arbitrary-attacker-supplied-string",
      hasLegacyHistory,
    });

    expect(resolved).not.toBe("arbitrary-attacker-supplied-string");
    expect(hasLegacyHistory).not.toHaveBeenCalled();
  });

  it("mints a fresh id (fails safe) when hasLegacyHistory rejects", async () => {
    const legacyId = `session-${Date.now()}-errcase12`;
    const hasLegacyHistory = vi.fn(async () => {
      throw new Error("db unavailable");
    });

    const resolved = await resolveIncomingSessionId({
      cookieHeader: undefined,
      legacyHeader: legacyId,
      hasLegacyHistory,
    });

    expect(resolved).not.toBe(legacyId);
  });

  it("ignores an invalid/tampered cookie and falls through to legacy/fresh logic", async () => {
    const hasLegacyHistory = vi.fn(async () => false);
    const resolved = await resolveIncomingSessionId({
      cookieHeader: `${SESSION_COOKIE_NAME}=garbage.notasignature`,
      legacyHeader: null,
      hasLegacyHistory,
    });
    expect(resolved).toBeTruthy();
  });
});
