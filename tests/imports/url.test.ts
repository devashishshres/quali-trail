import { describe, expect, it } from "vitest";
import { checkPublicUrl, checkUrlSyntax, isPublicAddress } from "@/lib/server/imports/url";

describe("isPublicAddress", () => {
  it.each(["8.8.8.8", "93.184.215.14", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"])("public: %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "2001:db8::1", "2002:0a00:0001::1", "2001::1",
  ])("not public: %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
});

describe("checkUrlSyntax", () => {
  it.each([
    ["ftp://jobs.example.com/x", /http and https/],
    ["https://user:pw@jobs.example.com/x", /username or password/],
    ["https://jobs.example.com:8443/x", /unusual ports/],
    ["http://localhost/x", /not a public/],
    ["http://intranet/x", /not a public/],
    ["http://metadata.google.internal/x", /not a public/],
    ["http://169.254.169.254/latest/meta-data", /not a public/],
    ["http://[::1]/x", /not a public/],
    ["http://[::ffff:127.0.0.1]/", /not a public/],
    ["http://printer.local/", /not a public/],
    ["not a url", /web link/],
  ])("%s", (u, msg) => {
    const r = checkUrlSyntax(u);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(msg);
  });

  it("accepts a public https listing and drops the fragment", () => {
    expect(checkUrlSyntax("https://jobs.example.com/listing/1?x=1#apply")).toEqual({ ok: true, url: "https://jobs.example.com/listing/1?x=1", host: "jobs.example.com" });
  });
});

describe("checkPublicUrl (DNS)", () => {
  const dns = (map: Record<string, string[]>) => async (h: string) => {
    if (!map[h]) throw new Error("ENOTFOUND");
    return map[h];
  };
  it("rejects a public-looking name that resolves to a private address (IPv4 or IPv6)", async () => {
    expect((await checkPublicUrl("https://evil.example.com/", dns({ "evil.example.com": ["93.184.215.14", "10.0.0.5"] }))).ok).toBe(false);
    expect((await checkPublicUrl("https://evil6.example.com/", dns({ "evil6.example.com": ["fd00::1"] }))).ok).toBe(false);
  });
  it("accepts when every address is public", async () => {
    expect((await checkPublicUrl("https://ok.example.com/", dns({ "ok.example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"] }))).ok).toBe(true);
  });
  it("unresolvable names are rejected without detail", async () => {
    const r = await checkPublicUrl("https://nope.example.com/", dns({}));
    expect(!r.ok && r.reason).toMatch(/couldn't be found/);
  });
});
