const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('_ipc', {
  minimize:       () => ipcRenderer.send('win-minimize'),
  maximize:       () => ipcRenderer.send('win-maximize'),
  close:          () => ipcRenderer.send('win-close'),
  browseFolder:   () => ipcRenderer.invoke('browse-folder'),
  downloadUpdate: (opts) => ipcRenderer.invoke('download-update', opts),
});
