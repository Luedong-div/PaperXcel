import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const electronViteCli = fileURLToPath(
  new URL("../node_modules/electron-vite/bin/electron-vite.js", import.meta.url),
);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [electronViteCli, "dev"], {
  stdio: "inherit",
  env: environment,
  shell: false,
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
