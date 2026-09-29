const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('api',{
  settings:()=>ipcRenderer.invoke('settings'),
  save:s=>ipcRenderer.invoke('save',s),
  ask:w=>ipcRenderer.invoke('ask',w),
  onStatus:f=>ipcRenderer.on('status',(e,t)=>f(t)),
  hide:()=>ipcRenderer.send('hide'),
  onStart:f=>ipcRenderer.on('start',f),
  onStop:f=>ipcRenderer.on('stop',f)});
