const {app,BrowserWindow,desktopCapturer,ipcMain,session,shell,Menu}=require('electron');
const path=require('path');
let mainWindow;
app.setAppUserModelId('com.golive.friends');
function chooseCaptureSource(){
  return new Promise(async(resolve)=>{
    let settled=false;
    const settle=(result)=>{if(settled)return;settled=true;ipcMain.removeHandler('golive:capture:list');ipcMain.removeHandler('golive:capture:choose');ipcMain.removeHandler('golive:capture:cancel');if(!picker.isDestroyed())picker.close();resolve(result)};
    const picker=new BrowserWindow({parent:mainWindow,modal:true,width:850,height:560,minWidth:680,minHeight:480,title:'GoLive · Selecionar transmissão',backgroundColor:'#0f1426',show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'capture-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    picker.on('closed',()=>settle(null));
    const authorized=(event)=>event.sender===picker.webContents;
    ipcMain.handle('golive:capture:list',async(event)=>{
      if(!authorized(event))throw Error('Unauthorized');
      const sources=await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:400,height:250}});
      return sources.map(source=>({id:source.id,name:source.name,type:source.id.startsWith('screen:')?'screen':'window',thumbnail:source.thumbnail.isEmpty()?'':source.thumbnail.toDataURL()}));
    });
    ipcMain.handle('golive:capture:choose',async(event,{id,audio})=>{
      if(!authorized(event))throw Error('Unauthorized');
      const sources=await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:0,height:0}});
      const source=sources.find(s=>s.id===id);
      if(!source)throw Error('Fonte não encontrada');
      settle({source,audio:Boolean(audio)});return true;
    });
    ipcMain.handle('golive:capture:cancel',async(event)=>{if(!authorized(event))throw Error('Unauthorized');settle(null);return true});
    picker.once('ready-to-show',()=>picker.show());
    try{await picker.loadFile(path.join(__dirname,'capture-picker.html'))}catch(e){console.error(e);settle(null)}
  });
}
app.whenReady().then(async()=>{
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionCheckHandler((_wc,permission)=>permission==='media'||permission==='display-capture'||permission==='fullscreen');
  session.defaultSession.setDisplayMediaRequestHandler(async(_request,callback)=>{
    try{
      const selected=await chooseCaptureSource();
      if(!selected){callback({});return;}
      callback({video:selected.source,...(selected.audio?{audio:'loopback'}:{})});
    }catch(e){console.error(e);callback({});}
  });
  mainWindow=new BrowserWindow({width:1280,height:800,minWidth:850,minHeight:590,title:'GoLive',backgroundColor:'#0b1020',autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  mainWindow.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith('https:'))void shell.openExternal(url);return {action:'deny'}});
  await mainWindow.loadURL('https://golive-ad118.web.app');
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
