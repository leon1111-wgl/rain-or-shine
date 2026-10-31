import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { HKO_RELAY_PREFIX, relayHko } from "../launcher/hko-relay.mjs";

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

export default defineConfig(({ mode }) => ({
  // Relative asset paths. Routing uses the hash, so the build also works under a subpath such as GitHub Pages.
  base: "./",
  cacheDir: fileURLToPath(new URL("../cache/vite-web", import.meta.url)),
  plugins: [react(), hkoRelay],
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
    // The file-upload and wallet flows run many awaited steps; on a loaded machine one can pass 5 s.
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
