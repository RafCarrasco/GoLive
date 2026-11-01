const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('capturePicker',{
  list:()=>ipcRenderer.invoke('golive:capture:list'),
  choose:(id,audio)=>ipcRenderer.invoke('golive:capture:choose',{id,audio}),
  cancel:()=>ipcRenderer.invoke('golive:capture:cancel')
});
