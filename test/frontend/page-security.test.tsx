import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HKO_OPEN_DATA_ORIGIN } from "../../src/weather/profile";
import { FramedNotice, isFramed } from "../../web/src/components/FramedNotice";
import { setActiveLocale } from "../../web/src/i18n";
import { webHref } from "../../web/src/lib/links";
import { pagePolicy, readOrigins, withPagePolicy } from "../../web/src/lib/page-policy";
import { SEPOLIA_FALLBACK_RPC, readUrls } from "../../web/src/metric/rpc-reader";

const sepolia = { environment: "SEPOLIA_UMA", publicRpcUrl: "https://sepolia.gateway.tenderly.co" };
const local = { environment: "LOCAL_MOCK", publicRpcUrl: "http://127.0.0.1:8545" };
const directives = (policy: string) => new Map(policy.split("; ").map((part) => {
  const [name, ...values] = part.split(" ");
  return [name!, values.join(" ")];
}));

describe("page policy", () => {
  it("reads Sepolia's state from the public RPC and its history from the deployment's gateway, a local chain from its own RPC", () => {
    expect(readUrls(sepolia)).toEqual({ current: SEPOLIA_FALLBACK_RPC, history: sepolia.publicRpcUrl });
    expect(readUrls(local)).toEqual({ current: local.publicRpcUrl });
  });

  it("loads scripts, styles, fonts and images from the site only, and reads only from the site, the RPCs and HKO", () => {
    const policy = directives(pagePolicy(readOrigins([...Object.values(readUrls(sepolia)), HKO_OPEN_DATA_ORIGIN])));
    expect(policy.get("default-src")).toBe("'none'");
    expect(policy.get("script-src")).toBe("'self'");
    expect(policy.get("style-src")).toBe("'self'");
    expect(policy.get("img-src")).toBe("'self' data:");
    expect(policy.get("font-src")).toBe("'self'");
    expect(policy.get("connect-src")).toBe("'self' https://ethereum-sepolia-rpc.publicnode.com https://sepolia.gateway.tenderly.co https://data.weather.gov.hk");
    for (const name of ["base-uri", "form-action", "object-src"]) expect(policy.get(name)).toBe("'none'");
    expect(policy.get("require-trusted-types-for")).toBe("'script'");
    expect(policy.get("trusted-types")).toBe("'none'");
    expect([...policy.values()].join(" ")).not.toMatch(/unsafe-|\*/);
  });

  it("refuses to read from a host without https, except a chain on this computer, and lists each origin once", () => {
    expect(readOrigins([`${local.publicRpcUrl}/`, "https://rpc.example.org/a", "https://rpc.example.org/b?x=1"])).toEqual(["http://127.0.0.1:8545", "https://rpc.example.org"]);
    expect(() => readOrigins(["http://rpc.example.org"])).toThrow("The page may not read from http://rpc.example.org");
    expect(() => readOrigins(["javascript:alert(1)"])).toThrow("The page may not read from null");
  });

  it("goes right after the charset, before anything the page loads", () => {
    const html = '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n    <title>t</title>\n    <script type="module" src="./a.js"></script>\n  </head>\n</html>\n';
    const out = withPagePolicy(html, "default-src 'none'; script-src 'self'");
    expect(out).toContain('<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'" />\n    <title>');
    expect(() => withPagePolicy("<head><title>t</title></head>", "default-src 'none'")).toThrow(/charset/);
    expect(() => withPagePolicy(html, 'default-src "none"')).toThrow(/quote/);
  });
});

describe("links from chain data", () => {
  it("become links only for web addresses", () => {
    expect(webHref("https://example.org/pressure.csv")).toBe("https://example.org/pressure.csv");
    expect(webHref("HTTP://Example.org")).toBe("http://example.org/");
    for (const value of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<b>x</b>", "vbscript:msgbox(1)", "file:///etc/hosts", "/relative", "not a url"]) {
      expect(webHref(value), value).toBeNull();
    }
  });
});

describe("frame guard", () => {
  it("tells a framed page from a page of its own", () => {
    const self = {};
    expect(isFramed({ top: self, self } as unknown as Window)).toBe(false);
    expect(isFramed({ top: {}, self } as unknown as Window)).toBe(true);
    expect(isFramed(Object.defineProperty({ self }, "top", { get: () => { throw new Error("blocked"); } }) as unknown as Window)).toBe(true);
    expect(isFramed(window)).toBe(false);
  });

  it("offers to open the app on its own instead of showing it inside another site, in both languages", () => {
    const { unmount } = render(<FramedNotice />);
    expect(screen.getByRole("heading")).toHaveTextContent("Rain or Shine opens on its own page");
    const link = screen.getByRole("link", { name: "Open Rain or Shine" });
    expect(link).toHaveAttribute("href", window.location.href);
    expect(link).toHaveAttribute("target", "_top");
    unmount();
    setActiveLocale("zh-CN");
    try {
      render(<FramedNotice />);
      expect(screen.getByRole("heading")).toHaveTextContent("Rain or Shine 需要单独打开");
      expect(screen.getByRole("link", { name: "打开 Rain or Shine" })).toHaveAttribute("target", "_top");
    } finally {
      setActiveLocale("en");
    }
  });
});
