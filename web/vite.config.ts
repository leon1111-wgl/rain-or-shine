import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { HKO_RELAY_PREFIX, relayHko } from "../launcher/hko-relay.mjs";
import { validateMetricManifest } from "../src/metric/deployment";
import { HKO_OPEN_DATA_ORIGIN } from "../src/weather/profile";
import { pagePolicy, readOrigins, withPagePolicy } from "./src/lib/page-policy";
import { readUrls } from "./src/metric/rpc-reader";

const shared = fileURLToPath(new URL("../src", import.meta.url));

const relayMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  if (req.method !== "GET" || !req.url?.startsWith(`${HKO_RELAY_PREFIX}/`)) return next();
  void relayHko(req.url).then((relayed) => {
    res.statusCode = relayed.status;
    res.setHeader("Content-Type", relayed.type);
    res.setHeader("Cache-Control", "no-store");
    res.end(relayed.body);
  });
};
const hkoRelay: Plugin = {
  name: "rainpool-hko-relay",
  configureServer: (server) => void server.middlewares.use(relayMiddleware),
  configurePreviewServer: (server) => void server.middlewares.use(relayMiddleware),
};

const generatedDeployments = fileURLToPath(new URL("./src/generated/metric-deployments.json", import.meta.url));
/** The built page's Content-Security-Policy (src/lib/page-policy.ts).
 * It allows the RPCs of the target chain and HKO's open-data host. selectMetricDeployment picks the chain.
 * The dev server needs inline scripts. Only the build gets the policy. */
function pagePolicyPlugin(): Plugin {
  let target: string | undefined;
  return {
    name: "rainpool-page-policy",
    apply: "build",
    configResolved: (config) => {
      const defined = config.define?.["import.meta.env.VITE_TARGET_CHAIN_ID"];
      target = typeof defined === "string" ? (JSON.parse(defined) as string) : (config.env.VITE_TARGET_CHAIN_ID as string | undefined);
    },
    transformIndexHtml: (html) => {
      const { deployments } = JSON.parse(readFileSync(generatedDeployments, "utf8")) as { deployments: Record<string, unknown> };
      const selected = deployments[target ?? "31337"];
      const rpc = selected ? Object.values(readUrls(validateMetricManifest(selected))) : [];
      return withPagePolicy(html, pagePolicy(readOrigins([...rpc, HKO_OPEN_DATA_ORIGIN])));
    },
  };
}

export default defineConfig(({ mode }) => ({
  // Relative asset paths. Routing uses the hash. The build also works under a subpath such as GitHub Pages.
  base: "./",
  cacheDir: fileURLToPath(new URL("../cache/vite-web", import.meta.url)),
  plugins: [react(), hkoRelay, pagePolicyPlugin()],
  define: mode === "local-chain" || mode === "sepolia"
    ? { "import.meta.env.VITE_TARGET_CHAIN_ID": JSON.stringify(mode === "sepolia" ? "11155111" : "31337") } : {},
  resolve: {
    alias: { "@shared": shared },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [".."] },
  },
  build: { outDir: "dist", sourcemap: true },
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["test/frontend/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["test/frontend/setup.ts"],
    // The file-upload and wallet flows await many steps. On a busy machine one test can pass 5 s.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["web/src/**/*.{ts,tsx}"],
      exclude: ["web/src/generated/**", "web/src/main.tsx"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage/web",
    },
  },
}));
