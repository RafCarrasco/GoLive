const {app,BrowserWindow,desktopCapturer,dialog,session,shell,Menu}=require('electron');
const path=require('path');
let win;
app.setAppUserModelId('com.golive.friends');
app.whenReady().then(async()=>{
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionCheckHandler((_wc,permission)=>permission==='media'||permission==='display-capture'||permission==='fullscreen');
  session.defaultSession.setDisplayMediaRequestHandler(async(_request,callback)=>{
    try{
      const sources=await desktopCapturer.getSources({types:['window','screen'],thumbnailSize:{width:0,height:0}});
      const choices=sources.map(s=>({label:s.name,detail:s.id})); 
      const response=await dialog.showMessageBox(win,{type:'question',title:'GoLive · Selecionar transmissão',message:'Escolha a janela ou monitor que deseja compartilhar',detail:'Captura de áudio do sistema é opcional. O isolamento por jogo ainda não está implementado.',buttons:[...choices.map(c=>c.label),'Cancelar'],cancelId:choices.length,noLink:true});
      if(response.response>=choices.length)return callback({});
      callback({video:sources[response.response],audio:'loopback'});
    }catch(e){console.error(e);callback({});}
  });
  win=new BrowserWindow({width:1280,height:800,minWidth:850,minHeight:590,title:'GoLive',backgroundColor:'#0b1020',autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith('https:'))shell.openExternal(url);return {action:'deny'}});
  await win.loadURL('https://golive-ad118.web.app');
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
