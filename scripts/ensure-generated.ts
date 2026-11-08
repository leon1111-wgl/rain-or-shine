// The web app imports the ABIs and deployment manifests from export-metric-deployment.ts.
// A fresh clone has none. This script creates missing ones and keeps existing ones.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const files = ["web/src/generated/metric-abi.json", "web/src/generated/metric-deployments.json"];
if (!files.every((file) => existsSync(file))) {
  const result = spawnSync("npm", ["run", "export:metric"], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
