import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI } from "./contract.js";
const api: DesktopAPI = {
  invoke: (command) => ipcRenderer.invoke("jobagent:command", command),
  chooseFile: (kind) => ipcRenderer.invoke("jobagent:file", kind),
  chooseDataDirectory: () => ipcRenderer.invoke("jobagent:data-dir"),
  exportDiagnostics: () => ipcRenderer.invoke("jobagent:diagnostics"),
  openFeishuAuth: () => ipcRenderer.invoke("jobagent:auth-link"),
  subscribe(listener) {
    const wrapped = () => listener();
    ipcRenderer.on("jobagent:changed", wrapped);
    return () => ipcRenderer.removeListener("jobagent:changed", wrapped);
  },
};
contextBridge.exposeInMainWorld("jobagent", Object.freeze(api));
