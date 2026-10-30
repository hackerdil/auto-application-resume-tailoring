import { describe, expect, it } from "vitest";
import { PolicyError } from "@career-agent/domain";
import { assertSafeDestination, checkUrl, isPublicIp, sameOrigin } from "./url-policy.js";

describe("checkUrl", () => {
  it("accepts public https URLs", () => {
    expect(checkUrl("https://boards-api.greenhouse.io/v1/boards/acme/jobs").hostname).toBe(
      "boards-api.greenhouse.io",
    );
  });

  it.each([
    "http://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://example.com/",
    "https://user:pass@example.com/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://2130706433/", // decimal 127.0.0.1
    "https://0x7f000001/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/",
    "https://192.168.1.1/",
    "https://printer.local/",
    "https://intranet/",
    "https://example.com:8443/",
    "not a url",
  ])("rejects %s", (u) => {
    expect(() => checkUrl(u)).toThrow(PolicyError);
  });

  it("enforces host allowlists (exact and subdomain rules)", () => {
    const policy = { allowedHosts: ["api.lever.co", ".greenhouse.io"] };
    expect(() => checkUrl("https://api.lever.co/v0/postings/x", policy)).not.toThrow();
    expect(() => checkUrl("https://boards-api.greenhouse.io/", policy)).not.toThrow();
    expect(() => checkUrl("https://greenhouse.io/", policy)).toThrow(/allowlist/);
    expect(() => checkUrl("https://evil-greenhouse.io/", policy)).toThrow(/allowlist/);
    expect(() => checkUrl("https://api.lever.co.evil.test/", policy)).toThrow();
  });

  it("allows local fixtures only when explicitly enabled", () => {
    const fixture = { allowPrivateNetwork: true, allowHttp: true, allowedPorts: [4173] };
    expect(checkUrl("http://127.0.0.1:4173/form", fixture).port).toBe("4173");
  });
});

describe("assertSafeDestination", () => {
  it("rejects hosts that resolve to private addresses (DNS rebinding)", async () => {
    const lookup = () => Promise.resolve([{ address: "93.184.216.34" }, { address: "10.1.2.3" }]);
    await expect(assertSafeDestination("https://jobs.example.com/", {}, lookup)).rejects.toThrow(
      /non-public/,
    );
  });

  it("accepts hosts resolving only to public addresses", async () => {
    const lookup = () => Promise.resolve([{ address: "93.184.216.34" }]);
    const r = await assertSafeDestination("https://jobs.example.com/", {}, lookup);
    expect(r.addresses).toEqual(["93.184.216.34"]);
  });

  it("rejects unresolvable hosts", async () => {
    await expect(
      assertSafeDestination("https://jobs.example.com/", {}, () => Promise.resolve([])),
    ).rejects.toThrow();
  });
});

describe("helpers", () => {
  it("classifies IPs", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIp("fd00::1")).toBe(false);
    expect(isPublicIp("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicIp("not-an-ip")).toBe(false);
  });

  it("compares origins", () => {
    expect(sameOrigin("https://a.test/x", "https://a.test/y")).toBe(true);
    expect(sameOrigin("https://a.test/", "https://a.test:8443/")).toBe(false);
  });
});
