import { existsSync, readFileSync, rmSync } from "node:fs";
import { PID_FILE } from "./global-setup.js";

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(PID_FILE)) return;
  const pids = JSON.parse(readFileSync(PID_FILE, "utf8")) as Record<string, number | undefined>;
  for (const pid of Object.values(pids)) {
    if (!pid) continue;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  }
  rmSync(PID_FILE);
}
