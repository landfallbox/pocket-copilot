const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getEnv: () => ipcRenderer.invoke('env:get'),
  saveEnv: (vars) => ipcRenderer.invoke('env:save', vars),
  vscodeRunning: () => ipcRenderer.invoke('vscode:running'),
  vscodeRestart: () => ipcRenderer.invoke('vscode:restart'),
  daemonStart: () => ipcRenderer.invoke('daemon:start'),
  daemonStop: () => ipcRenderer.invoke('daemon:stop'),
  tunnelStart: () => ipcRenderer.invoke('tunnel:start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel:stop'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  statusNow: () => ipcRenderer.invoke('status:now'),
  openLog: (which) => ipcRenderer.invoke('open:log', which),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
});
