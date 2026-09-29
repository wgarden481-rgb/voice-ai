const {app,BrowserWindow,Tray,Menu,ipcMain,screen,session,nativeImage,safeStorage}=require('electron');
const path=require('path'),fs=require('fs');
const {uIOhook}=require('uiohook-napi');
const nodemailer=require('nodemailer');
let setupWin,settingsWin,overlay,tray,settings=null,pending=null,turnNo=0;
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
function openSettings(){
  if(!settings)return openSetup();
  if(settingsWin)return settingsWin.focus();
  settingsWin=new BrowserWindow({width:680,height:680,title:'Voice AI Settings',autoHideMenuBar:true,webPreferences:prefs});
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed',()=>settingsWin=null);
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
ipcMain.handle('settings',()=>settings&&{lang:settings.lang,langName:settings.langName,voice:settings.voice,autostart:settings.autostart,
  hasKey:!!settings.apiKey,gmail:settings.gmail?{address:settings.gmail.address,hasPass:!!settings.gmail.pass}:null,contacts:settings.contacts||[]});
ipcMain.handle('save',(e,s)=>{
  const o=settings||{};
  settings={...s,apiKey:s.apiKey||o.apiKey,gmail:s.gmail&&s.gmail.address?{address:s.gmail.address,
    pass:s.gmail.pass?safeStorage.encryptString(s.gmail.pass).toString('base64'):(o.gmail&&o.gmail.pass)||''}:null};
  fs.writeFileSync(file(),JSON.stringify(settings));
  app.setLoginItemSettings({openAtLogin:!!s.autostart});
  if(setupWin){setupWin.close();setupWin=null}
  if(settingsWin){settingsWin.close();settingsWin=null}
});

const BASE='https://api.groq.com/openai/v1';
const MODELS=['openai/gpt-oss-120b','openai/gpt-oss-20b']; // Groq retires models; next one is tried if one is gone
const today=()=>new Date().toLocaleString('en-US',{dateStyle:'full',timeStyle:'short'});
async function groq(p,init){
  const r=await fetch(BASE+p,{...init,headers:{Authorization:'Bearer '+settings.apiKey,...init.headers}}),j=await r.json();
  if(!r.ok)throw new Error(j.error?.message||r.status);return j;
}
async function chat(body){
  let err;
  for(const model of MODELS){
    try{return await groq('/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,...body})})}
    catch(e){err=e;if(!/does not exist|decommission|not found|no access|access to it/i.test(e.message))throw e}
  }
  throw err;
}
const fn=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required}}});
const S=d=>({type:'string',description:d});
const TOOLS=[
  fn('look_up','Search the live web. Use for anything recent, current, news, sports, prices, or facts that may have changed.',{query:S('search query')},['query']),
  fn('draft_email','Prepare an email to a saved contact. Does NOT send it.',{contact:S('name of a saved contact'),subject:S('subject'),body:S('full email text')},['contact','subject','body']),
  fn('send_pending_email','Send the drafted email. Only after the user clearly said yes in their newest message.'),
  fn('cancel_pending_email','Discard the drafted email.')];
function sys(){
  const cs=(settings.contacts||[]).map(c=>c.name).join(', ')||'none';
  const p=pending&&Date.now()-pending.t<300000?pending:null;if(!p)pending=null;
  return `You are a friendly voice assistant on the user's PC. Today is ${today()}. Your built-in knowledge is old, so for anything recent, current or changeable (news, events, sports, prices, who holds a job, weather, releases) you MUST call look_up instead of answering from memory, and never say you only know up to a past year. Reply in ${settings.langName} in 1-3 short spoken-style sentences, no markdown, lists or emojis. Saved email contacts: ${cs}. To email someone call draft_email, then read the draft back briefly (who, subject, gist) and ask the user to say yes to send. Call send_pending_email only when the user's newest message clearly confirms, and cancel_pending_email if they decline. Never say an email was sent unless send_pending_email returned "Sent".`
   +(p?` A draft is waiting: to ${p.name}, subject "${p.subject}", body "${p.body}".`:'');
}
async function runTool(n,a,turn,status){
  if(n==='look_up'){
    status('Searching the web…');
    const j=await chat({messages:[{role:'system',content:`Today is ${today()}. Search the web and report the key current facts in under 120 words.`},{role:'user',content:a.query}],
      tools:[{type:'browser_search'}],reasoning_effort:'low',max_completion_tokens:3000});
    return j.choices[0].message.content||'No results found.';
  }
  if(n==='draft_email'){
    const g=settings.gmail;if(!g||!g.pass)return 'Gmail is not connected. Tell the user to add it in Voice AI settings (tray icon).';
    const k=String(a.contact||'').toLowerCase().trim(),cs=settings.contacts||[],nm=x=>x.name.toLowerCase();
    const c=cs.find(x=>nm(x)===k)||(k&&cs.find(x=>nm(x).includes(k)||k.includes(nm(x))));
    if(!c)return `No saved contact called "${a.contact}". Saved: ${cs.map(x=>x.name).join(', ')||'none'}. Tell the user to add them in settings.`;
    pending={name:c.name,to:c.email,subject:a.subject,body:a.body,turn,t:Date.now()};
    return 'Draft saved, NOT sent. Read it back briefly and ask the user to say yes to send or no to cancel.';
  }
  if(n==='send_pending_email'){
    if(!pending)return 'There is no draft to send.';
    if(pending.turn===turn)return 'Not confirmed yet. Ask the user to say yes first.';
    const g=settings.gmail,pass=safeStorage.decryptString(Buffer.from(g.pass,'base64'));
    await nodemailer.createTransport({service:'gmail',auth:{user:g.address,pass}}).sendMail({from:g.address,to:pending.to,subject:pending.subject,text:pending.body});
    pending=null;return 'Sent.';
  }
  if(n==='cancel_pending_email'){pending=null;return 'Draft discarded.'}
  return 'Unknown tool.';
}
ipcMain.handle('ask',async(e,wav)=>{
  try{
    const fd=new FormData();fd.append('file',new Blob([wav],{type:'audio/wav'}),'q.wav');
    fd.append('model','whisper-large-v3-turbo');fd.append('language',settings.lang.split('-')[0]);
    const question=((await groq('/audio/transcriptions',{method:'POST',body:fd})).text||'').trim();
    if(!question)return{question:'',answer:''};
    const turn=++turnNo,messages=[{role:'system',content:sys()},{role:'user',content:question}];
    for(let i=0;i<5;i++){
      const m=(await chat({messages,tools:TOOLS,reasoning_effort:'low',max_completion_tokens:1500})).choices[0].message;
      if(!m.tool_calls?.length){const answer=(m.content||'').trim();if(!answer)throw new Error('Empty answer');return{question,answer}}
      messages.push({role:'assistant',content:m.content||'',tool_calls:m.tool_calls});
      for(const c of m.tool_calls){
        let out;try{out=await runTool(c.function.name,JSON.parse(c.function.arguments||'{}'),turn,t=>e.sender.send('status',t))}catch(x){out='Error: '+x.message}
        messages.push({role:'tool',tool_call_id:c.id,content:String(out)});
      }
    }
    return{question,answer:'Sorry, that took too many steps. Please try again.'};
  }catch(err){return{error:String(err.message||err)}}
});
ipcMain.on('hide',()=>overlay&&overlay.hide());

app.whenReady().then(()=>{
  session.defaultSession.setPermissionRequestHandler((wc,p,cb)=>cb(p==='media'));
  try{settings=JSON.parse(fs.readFileSync(file()))}catch{}
  makeOverlay();startHotkey();
  tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'icon.png')).resize({width:16,height:16}));
  tray.setToolTip('Voice AI — hold Left Ctrl + Left Alt and ask');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Settings',click:openSettings},{label:'Quit Voice AI',click:()=>app.exit()}]));
  if(!settings)openSetup();
});
