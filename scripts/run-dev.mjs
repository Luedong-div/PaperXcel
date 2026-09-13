import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

const electronViteCli = fileURLToPath(
  new URL(
    "../node_modules/electron-vite/bin/electron-vite.js",
    import.meta.url,
  ),
);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once("error", reject);
  portProbe.listen(0, "127.0.0.1", resolve);
});
environment.PAPERXCEL_DEV_BRIDGE_PORT = String(portProbe.address().port);
environment.PAPERXCEL_DEV_BRIDGE_NONCE = randomBytes(32).toString("hex");
await new Promise((resolve, reject) =>
  portProbe.close((error) => (error ? reject(error) : resolve())),
);

const child = spawn(
  process.execPath,
  [electronViteCli, "dev", "--watch", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: environment,
    shell: false,
  },
);

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
