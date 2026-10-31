import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Bundle the existing parser and its hash dependencies. Receiving machines need
// only the packaged Node runtime. No npm installation or environment files.
await build({
  root, configFile: false, envDir: false, publicDir: false,
  ssr: { noExternal: true },
  build: {
    ssr: resolve(root, "scripts/get-weather-evidence.ts"), target: "node22",
    outDir: resolve(root, "cache/portable-weather"), emptyOutDir: true,
    minify: false, sourcemap: false,
    rolldownOptions: { output: { entryFileNames: "get-weather-evidence.mjs", format: "es" } },
  },
});
