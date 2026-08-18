import { spawn } from "node:child_process";

const env = { ...process.env, NODE_ENV: "development" };

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--env-file", ".env", "server/index.ts"],
  {
    env,
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
