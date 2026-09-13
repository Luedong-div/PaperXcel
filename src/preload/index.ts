import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createPaperXcelApi } from "../shared/paperxcel-api";

contextBridge.exposeInMainWorld(
  "paperxcel",
  createPaperXcelApi({
    invoke: ipcRenderer.invoke.bind(ipcRenderer),
    on: ipcRenderer.on.bind(ipcRenderer),
    removeListener: ipcRenderer.removeListener.bind(ipcRenderer),
    getPathForFile: webUtils.getPathForFile.bind(webUtils),
  }),
);
