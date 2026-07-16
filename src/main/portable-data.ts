import { app } from "electron";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PORTABLE_DATA_DIRECTORY_NAME = "PaperXcel-Data";

interface ApplicationDataPaths {
  userData: string;
  sessionData: string;
  logs: string;
  crashDumps: string;
}

export function configureApplicationDataPaths(): ApplicationDataPaths {
  const overridePath = process.env.PAPERXCEL_E2E_USER_DATA?.trim();
  const userDataPath = overridePath
    ? resolve(overridePath)
    : app.isPackaged
      ? join(dirname(process.execPath), PORTABLE_DATA_DIRECTORY_NAME)
      : app.getPath("userData");

  const paths: ApplicationDataPaths = {
    userData: userDataPath,
    sessionData: join(userDataPath, "session-data"),
    logs: join(userDataPath, "logs"),
    crashDumps: join(userDataPath, "crash-dumps"),
  };

  for (const directory of Object.values(paths)) {
    mkdirSync(directory, { recursive: true });
  }

  app.setPath("userData", paths.userData);
  app.setPath("sessionData", paths.sessionData);
  app.setPath("logs", paths.logs);
  app.setPath("crashDumps", paths.crashDumps);
  app.commandLine.appendSwitch(
    "disk-cache-dir",
    join(paths.sessionData, "Cache"),
  );
  app.commandLine.appendSwitch(
    "gpu-disk-cache-dir",
    join(paths.sessionData, "GPUCache"),
  );

  return paths;
}
