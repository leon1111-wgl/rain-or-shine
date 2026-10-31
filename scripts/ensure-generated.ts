// The web app imports the ABIs and deployment manifests that export-metric-deployment.ts writes, and a fresh clone
// has none yet. Generate them once when they are missing. Existing ones are left as they are.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const files = ["web/src/generated/metric-abi.json", "web/src/generated/metric-deployments.json"];
if (!files.every((file) => existsSync(file))) {
  const result = spawnSync("npm", ["run", "export:metric"], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
