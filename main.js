const {app,BrowserWindow,Tray,Menu,ipcMain,screen,session,nativeImage}=require('electron');
const path=require('path'),fs=require('fs');
const {uIOhook}=require('uiohook-napi');
let setupWin,overlay,tray,settings=null;
const file=()=>path.join(app.getPath('userData'),'settings.json');
const prefs={preload:path.join(__dirname,'preload.js')};
if(!app.requestSingleInstanceLock())app.quit();
app.on('window-all-closed',()=>{}); // keep running in background

function openSetup(){
  if(setupWin)return setupWin.focus();
  setupWin=new BrowserWindow({width:640,height:640,title:'Voice AI Setup',autoHideMenuBar:true,webPreferences:prefs});
  setupWin.loadFile('setup.html');
  setupWin.on('closed',()=>setupWin=null);
}
function makeOverlay(){
  const W=560,wa=screen.getPrimaryDisplay().workArea;
  overlay=new BrowserWindow({width:W,height:220,x:Math.round(wa.x+(wa.width-W)/2),y:wa.y+12,frame:false,transparent:true,
    alwaysOnTop:true,focusable:false,skipTaskbar:true,resizable:false,show:false,webPreferences:prefs});
  overlay.setAlwaysOnTop(true,'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.loadFile('overlay.html');
}
// Hold Left Ctrl + Left Alt to talk; release to send.
function startHotkey(){
  let ctrl=false,alt=false,active=false;
  uIOhook.on('keydown',e=>{
    if(e.keycode===29)ctrl=true; if(e.keycode===56)alt=true;
    if(ctrl&&alt&&!active&&settings){active=true;overlay.showInactive();overlay.webContents.send('start');}
  });
  uIOhook.on('keyup',e=>{
    if(e.keycode===29)ctrl=false; if(e.keycode===56)alt=false;
    if(active&&!(ctrl&&alt)){active=false;overlay.webContents.send('stop');}
  });
  uIOhook.start();
}
ipcMain.handle('settings',()=>settings);
ipcMain.handle('save',(e,s)=>{
  settings=s;fs.writeFileSync(file(),JSON.stringify(s));
  app.setLoginItemSettings({openAtLogin:!!s.autostart});
  if(setupWin)setupWin.close();
});
ipcMain.handle('ask',async(e,wav)=>{
  try{
    const base='https://api.groq.com/openai/v1',H={Authorization:'Bearer '+settings.apiKey};
    const fd=new FormData();fd.append('file',new Blob([wav],{type:'audio/wav'}),'q.wav');
    fd.append('model','whisper-large-v3-turbo');fd.append('language',settings.lang.split('-')[0]);
    let r=await fetch(base+'/audio/transcriptions',{method:'POST',headers:H,body:fd}),j=await r.json();
    if(!r.ok)throw new Error(j.error?.message||r.status);
    const question=(j.text||'').trim();if(!question)return{question:'',answer:''};
    r=await fetch(base+'/chat/completions',{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({
      model:'llama-3.3-70b-versatile',temperature:0.5,max_tokens:250,messages:[
      {role:'system',content:`You are a friendly voice assistant. Answer in ${settings.langName} in 1-3 short spoken-style sentences. No markdown, lists or emojis.`},
      {role:'user',content:question}]})});
    j=await r.json();if(!r.ok)throw new Error(j.error?.message||r.status);
    return{question,answer:j.choices[0].message.content.trim()};
  }catch(err){return{error:String(err.message||err)}}
});
ipcMain.on('hide',()=>overlay&&overlay.hide());

app.whenReady().then(()=>{
  session.defaultSession.setPermissionRequestHandler((wc,p,cb)=>cb(p==='media'));
  try{settings=JSON.parse(fs.readFileSync(file()))}catch{}
  makeOverlay();startHotkey();
  tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'icon.png')).resize({width:16,height:16}));
  tray.setToolTip('Voice AI — hold Left Ctrl + Left Alt and ask');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Settings',click:openSetup},{label:'Quit Voice AI',click:()=>app.exit()}]));
  if(!settings)openSetup();
});
