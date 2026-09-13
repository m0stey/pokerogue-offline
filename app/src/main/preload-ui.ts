// Preload for our own small pages only (conflict, settings, splash). The game itself runs with
// no preload at all. The bridge is four calls wide and carries plain data in both directions.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pokerogue", {
  /** Everything this page has to show. */
  data: (): Promise<unknown> => ipcRenderer.invoke("ui:data"),
  /** Send the page's answer (conflict choice, or a settings change). */
  submit: (value: unknown): Promise<unknown> => ipcRenderer.invoke("ui:submit", value),
  /** Open the backups folder in Explorer. */
  openBackups: (): Promise<unknown> => ipcRenderer.invoke("ui:open-backups"),
  /** Close this page. */
  close: (): Promise<unknown> => ipcRenderer.invoke("ui:close"),
});
