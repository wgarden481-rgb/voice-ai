const {app,BrowserWindow,Tray,Menu,ipcMain,screen,session,nativeImage,safeStorage,Notification,shell,desktopCapturer}=require('electron');
const path=require('path'),fs=require('fs'),crypto=require('crypto'),http=require('http');
const {uIOhook}=require('uiohook-napi');
let setupWin,settingsWin,overlay,tray,settings=null,pending=null,turnNo=0;
const file=()=>path.join(app.getPath('userData'),'settings.json');
const prefs={preload:path.join(__dirname,'preload.js')};

// Encrypts secrets with Windows' own vault before saving. Falls back safely if that vault
// isn't available, instead of crashing the save.
const encPass=p=>{if(!p)return '';try{if(safeStorage.isEncryptionAvailable())return 'enc:'+safeStorage.encryptString(p).toString('base64');}catch{}return 'plain:'+Buffer.from(p).toString('base64');};
const decPass=v=>{
  if(!v)return '';
  try{
    if(v.startsWith('enc:'))return safeStorage.decryptString(Buffer.from(v.slice(4),'base64'));
    if(v.startsWith('plain:'))return Buffer.from(v.slice(6),'base64').toString();
    return safeStorage.decryptString(Buffer.from(v,'base64')); // older saved format
  }catch{return v}
};
// Keeps Google's short error code (invalid_grant, invalid_client, ...) in the message even when
// a longer description is also present, so googleError() below can still recognize it.
function oauthErr(j,fallback){return new Error((j&&j.error?j.error+': ':'')+((j&&j.error_description)||fallback||'OAuth error'))}
function googleError(e){
  const m=(e&&e.message)||String(e),c=e&&e.cause&&e.cause.code;
  if(/invalid_grant/i.test(m))return 'Your Google sign-in expired. That happens about once a week for a personal project like this one — open Settings and click "Sign in with Google" again.';
  if(/access_denied/i.test(m))return 'Google sign-in was cancelled or denied.';
  if(/redirect_uri_mismatch/i.test(m))return 'Google rejected the sign-in address. Double-check the Client ID and Secret were copied correctly.';
  if(/invalid_client/i.test(m))return 'Google did not recognize that Client ID or Secret. Re-check them in Google Cloud Console.';
  if(c==='ENOTFOUND'||c==='ETIMEDOUT'||c==='ECONNREFUSED')return 'Could not reach Google. Check the internet connection and try again.';
  return 'Google error: '+m;
}
if(!app.requestSingleInstanceLock())app.quit();
// Opening the app (Start Menu, desktop icon, running the installer again) while it's already
// running in the tray used to do nothing visible. Now it brings up Settings instead.
app.on('second-instance',()=>{settings?openSettings():openSetup();});
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
  settingsWin=new BrowserWindow({width:700,height:700,title:'Voice AI Settings',autoHideMenuBar:true,webPreferences:prefs});
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
  hasKey:!!settings.apiKey,
  google:settings.google?{address:settings.google.address||'',connected:!!settings.google.refreshToken,hasCreds:!!(settings.google.clientId&&settings.google.clientSecret)}:null,
  contacts:settings.contacts||[]});
ipcMain.handle('save',(e,s)=>{
  const o=settings||{},og=o.google||{};
  const clientId=(s.google&&s.google.clientId)||'',clientSecret=(s.google&&s.google.clientSecret)||'';
  let google=null;
  if(clientId||clientSecret||og.refreshToken){
    google={clientId:clientId?encPass(clientId):(og.clientId||''),clientSecret:clientSecret?encPass(clientSecret):(og.clientSecret||''),
      refreshToken:og.refreshToken||'',address:og.address||''};
  }
  settings={...s,apiKey:s.apiKey||o.apiKey,google,contacts:s.contacts||[]};
  fs.writeFileSync(file(),JSON.stringify(settings));
  app.setLoginItemSettings({openAtLogin:!!s.autostart});
  if(setupWin){setupWin.close();setupWin=null}
  if(settingsWin){settingsWin.close();settingsWin=null}
});

// ---- Google sign-in (loopback OAuth + PKCE, the standard flow for desktop apps) ----
function pkcePair(){
  const verifier=crypto.randomBytes(64).toString('base64url');
  const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
  return {verifier,challenge};
}
function googleSignIn(clientId,clientSecret){
  return new Promise((resolve,reject)=>{
    const {verifier,challenge}=pkcePair();
    let redirectUri,done=false;
    const finish=(fn,val)=>{if(done)return;done=true;try{server.close()}catch{};fn(val)};
    const server=http.createServer((req,res)=>{
      (async()=>{
        let u;try{u=new URL(req.url,'http://127.0.0.1')}catch{res.end();return}
        if(u.pathname!=='/callback'){res.writeHead(404);res.end();return}
        const code=u.searchParams.get('code'),err=u.searchParams.get('error');
        res.writeHead(200,{'Content-Type':'text/html'});
        res.end('<html><body style="font-family:system-ui,sans-serif;padding:60px;text-align:center;color:#1b2333"><h2>You are signed in.</h2><p>You can close this tab and go back to Voice AI.</p></body></html>');
        if(err)return finish(reject,new Error('access_denied'));
        if(!code)return finish(reject,new Error('Google did not send back a sign-in code.'));
        try{
          const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:new URLSearchParams({code,client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code',code_verifier:verifier})});
          const j=await r.json();
          if(!r.ok)throw oauthErr(j,'Google sign-in failed.');
          finish(resolve,j);
        }catch(e){finish(reject,e)}
      })();
    });
    server.listen(0,'127.0.0.1',()=>{
      const port=server.address().port;
      redirectUri=`http://127.0.0.1:${port}/callback`;
      const authUrl='https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({
        client_id:clientId,redirect_uri:redirectUri,response_type:'code',
        scope:'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly openid email',
        access_type:'offline',prompt:'consent',code_challenge:challenge,code_challenge_method:'S256'}).toString();
      shell.openExternal(authUrl);
    });
    setTimeout(()=>finish(reject,new Error('No response from Google after 3 minutes. If you saw a Google page saying "Access blocked" with a 403 error, add your exact email under Audience \u2192 Test users in Google Cloud Console, then try again.')),180000);
  });
}
async function fetchGoogleEmail(accessToken){
  const r=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+accessToken}});
  const j=await r.json();
  if(!r.ok)throw new Error(j.error_description||j.error||'Could not read the signed-in account.');
  return j.email||'';
}
async function googleAccessToken(){
  const g=settings&&settings.google;
  if(!g||!g.refreshToken)throw new Error('Gmail is not connected.');
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:decPass(g.clientId),client_secret:decPass(g.clientSecret),refresh_token:decPass(g.refreshToken),grant_type:'refresh_token'})});
  const j=await r.json();
  if(!r.ok)throw oauthErr(j,'invalid_grant');
  return j.access_token;
}
const b64url=s=>Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function gmailSend(to,subject,body){
  const token=await googleAccessToken(),from=settings.google.address;
  const raw=b64url([`From: ${from}`,`To: ${to}`,`Subject: ${subject}`,'Content-Type: text/plain; charset="UTF-8"','',body].join('\r\n'));
  const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({raw})});
  if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error?.message||('Gmail API error '+r.status))}
}
async function gmailListRecent(limit=15){
  const token=await googleAccessToken();
  const lr=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&labelIds=INBOX`,{headers:{Authorization:'Bearer '+token}});
  const lj=await lr.json();
  if(!lr.ok)throw new Error(lj.error?.message||('Gmail API error '+lr.status));
  const out=[];
  for(const m of (lj.messages||[])){
    const mr=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,{headers:{Authorization:'Bearer '+token}});
    const mj=await mr.json();if(!mr.ok)continue;
    const h=Object.fromEntries((mj.payload&&mj.payload.headers||[]).map(x=>[x.name,x.value]));
    out.push({from:h.From||'Unknown',subject:h.Subject||'(no subject)',date:h.Date||'',text:(mj.snippet||'').slice(0,400)});
  }
  return out;
}
ipcMain.handle('googleConnect',async(e,{clientId,clientSecret})=>{
  try{
    const id=(clientId||'').trim(),secret=(clientSecret||'').trim();
    if(!id||!secret)return{ok:false,error:'Paste both the Client ID and Client Secret first.'};
    const tokens=await googleSignIn(id,secret);
    if(!tokens.refresh_token)return{ok:false,error:'Google did not hand back a long-term sign-in. In your Google Account under Security \u203a Third-party access, remove Voice AI, then try signing in again.'};
    const address=await fetchGoogleEmail(tokens.access_token).catch(()=>'');
    settings={...(settings||{}),google:{clientId:encPass(id),clientSecret:encPass(secret),refreshToken:encPass(tokens.refresh_token),address}};
    fs.writeFileSync(file(),JSON.stringify(settings));
    return{ok:true,address};
  }catch(err){return{ok:false,error:googleError(err)}}
});
ipcMain.handle('googleDisconnect',()=>{
  if(settings&&settings.google){settings={...settings,google:{...settings.google,refreshToken:'',address:''}};fs.writeFileSync(file(),JSON.stringify(settings))}
  return{ok:true};
});
ipcMain.handle('testEmail',async()=>{
  try{
    if(!settings.google||!settings.google.refreshToken)return{ok:false,error:'Sign in with Google first, then try again.'};
    await gmailSend(settings.google.address,'Voice AI test email','If you can read this, Gmail sending works.');
    return{ok:true};
  }catch(e){return{ok:false,error:googleError(e)}}
});
ipcMain.handle('testInbox',async()=>{
  try{
    if(!settings.google||!settings.google.refreshToken)return{ok:false,error:'Sign in with Google first, then try again.'};
    return{ok:true,emails:await gmailListRecent(3)};
  }catch(e){return{ok:false,error:googleError(e)}}
});

// ---- The AI itself: Groq for chat/vision/transcription, plus tools it can call ----
const BASE='https://api.groq.com/openai/v1';
const MODELS=['openai/gpt-oss-120b','openai/gpt-oss-20b']; // Groq retires models; next one is tried if one is gone
const VISION_MODELS=['qwen/qwen3.8-27b','qwen/qwen3.6-27b']; // Groq's current vision-capable models, newest first
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
async function visionChat(question,b64){
  let err;
  for(const model of VISION_MODELS){
    try{return await groq('/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      model,temperature:1,max_completion_tokens:600,
      messages:[{role:'user',content:[{type:'text',text:question},{type:'image_url',image_url:{url:`data:image/jpeg;base64,${b64}`}}]}]})})}
    catch(e){err=e;if(!/does not exist|decommission|not found|no access|access to it/i.test(e.message))throw e}
  }
  throw err;
}
async function screenshotBase64(){
  const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1600,height:1600}});
  if(!sources.length||sources[0].thumbnail.isEmpty())throw new Error('Could not capture the screen.');
  return sources[0].thumbnail.toJPEG(70).toString('base64');
}
const fn=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required}}});
const S=d=>({type:'string',description:d});
const TOOLS=[
  fn('look_up','Search the live web for information. Use for anything recent, current, news, sports, prices, or facts that may have changed. This does NOT open a browser, it only returns text.',{query:S('search query')},['query']),
  fn('open_website','Open a website in the user\'s default browser. Use when the user says "open", "go to", "pull up", or names a site or app they want visiting, e.g. YouTube, Gmail, a news site.',{url:S('The site to open, e.g. "youtube.com" or "https://example.com"')},['url']),
  fn('look_at_screen','Take a screenshot of the user\'s screen right now and answer a question about what is visible: an error message, code, a document, a photo, anything. Use whenever they refer to "this", "my screen", or ask you to read or describe something visible.',{question:S('what to look for or answer about the screen')},['question']),
  fn('check_email','Look at the user\'s recent Gmail inbox to answer questions like whether an email arrived, who it is from, or what it says.',{query:S('optional: a contact name, address, or keyword to search recent messages for; leave blank for the latest emails')}),
  fn('draft_email','Prepare an email to a saved contact. Does NOT send it.',{contact:S('name of a saved contact'),subject:S('subject'),body:S('full email text')},['contact','subject','body']),
  fn('send_pending_email','Send the drafted email. Only after the user clearly said yes in their newest message.'),
  fn('cancel_pending_email','Discard the drafted email.')];
function normUrl(u){
  u=String(u||'').trim();if(!u)return null;
  if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(u))u='https://'+u;
  try{const p=new URL(u);return /^https?:$/.test(p.protocol)?p.href:null}catch{return null}
}
function sys(){
  const cs=(settings.contacts||[]).map(c=>c.name).join(', ')||'none';
  const p=pending&&Date.now()-pending.t<300000?pending:null;if(!p)pending=null;
  return `You are a friendly voice assistant on the user's PC. Today is ${today()}. Your built-in knowledge is old, so for anything recent, current or changeable (news, events, sports, prices, who holds a job, weather, releases) you MUST call look_up instead of answering from memory, and never say you only know up to a past year. If the user asks you to open, visit, go to, or pull up a website or app (like "open YouTube" or "go to gmail.com"), call open_website instead of look_up — that actually launches their browser there. If they refer to something on their screen, an image, code, an error, or say "this" or "what I'm looking at", call look_at_screen. If they ask whether an email arrived, who it's from, or what it says, call check_email. Reply in ${settings.langName} in 1-3 short spoken-style sentences, no markdown, lists or emojis. Saved email contacts: ${cs}. To email someone call draft_email, then read the draft back briefly (who, subject, gist) and ask the user to say yes to send. Call send_pending_email only when the user's newest message clearly confirms, and cancel_pending_email if they decline. Never say an email was sent unless send_pending_email returned "Sent".`
   +(p?` A draft is waiting: to ${p.name}, subject "${p.subject}", body "${p.body}".`:'');
}
async function runTool(n,a,turn,status){
  if(n==='look_up'){
    status('Searching the web…');
    const j=await chat({messages:[{role:'system',content:`Today is ${today()}. Search the web and report the key current facts in under 120 words.`},{role:'user',content:a.query}],
      tools:[{type:'browser_search'}],reasoning_effort:'low',max_completion_tokens:3000});
    return j.choices[0].message.content||'No results found.';
  }
  if(n==='open_website'){
    const href=normUrl(a.url);
    if(!href)return `Could not understand the web address "${a.url}". Ask the user which site they mean.`;
    status('Opening '+href+'…');
    await shell.openExternal(href);
    return 'Opened '+href+' in the browser.';
  }
  if(n==='look_at_screen'){
    status('Looking at your screen…');
    let b64;try{b64=await screenshotBase64()}catch(e){return 'Could not capture the screen: '+e.message}
    try{
      const j=await visionChat(a.question||'Describe what is on the screen.',b64);
      return j.choices[0].message.content||'Nothing useful could be made out on the screen.';
    }catch(e){return 'Could not read the screen right now: '+e.message}
  }
  if(n==='check_email'){
    status('Checking your inbox…');
    if(!settings.google||!settings.google.refreshToken)return 'Gmail is not connected. Tell the user to sign in with Google in Voice AI settings (tray icon).';
    let emails;try{emails=await gmailListRecent(20)}catch(e){return googleError(e)}
    if(!emails.length)return 'The inbox looks empty, or nothing could be read.';
    const q=String(a.query||'').toLowerCase().trim();
    const matches=q?emails.filter(m=>(m.from+m.subject+m.text).toLowerCase().includes(q)):emails;
    if(!matches.length)return `No recent email found matching "${a.query}" in the last ${emails.length} messages.`;
    return matches.slice(0,8).map((m,i)=>`${i+1}. From ${m.from}, subject "${m.subject}", ${m.date}: ${m.text}`).join('\n');
  }
  if(n==='draft_email'){
    const g=settings.google;if(!g||!g.refreshToken)return 'Gmail is not connected. Tell the user to sign in with Google in Voice AI settings (tray icon).';
    const k=String(a.contact||'').toLowerCase().trim(),cs=settings.contacts||[],nm=x=>x.name.toLowerCase();
    const c=cs.find(x=>nm(x)===k)||(k&&cs.find(x=>nm(x).includes(k)||k.includes(nm(x))));
    if(!c)return `No saved contact called "${a.contact}". Saved: ${cs.map(x=>x.name).join(', ')||'none'}. Tell the user to add them in settings.`;
    pending={name:c.name,to:c.email,subject:a.subject,body:a.body,turn,t:Date.now()};
    return 'Draft saved, NOT sent. Read it back briefly and ask the user to say yes to send or no to cancel.';
  }
  if(n==='send_pending_email'){
    if(!pending)return 'There is no draft to send.';
    if(pending.turn===turn)return 'Not confirmed yet. Ask the user to say yes first.';
    const g=settings.google;
    if(!g||!g.refreshToken)return 'Gmail is not connected. Tell the user to sign in with Google in Voice AI settings.';
    try{await gmailSend(pending.to,pending.subject,pending.body)}catch(e){return googleError(e)}
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
  tray.on('click',openSettings); // left-click the tray icon also opens Settings, not just right-click
  if(!settings)openSetup();
  else if(Notification.isSupported())new Notification({title:'Voice AI is running',body:'Right-click the icon near your clock, or reopen Voice AI, to see Settings.'}).show();
});
