import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,rm,mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {createEmbeddedDatabase} from '../../server/database.mjs';
import {bootstrap} from '../../scripts/setup.mjs';
import {provisionLocalDriverUat} from '../../scripts/local-driver-uat.mjs';
import {hash} from '../../server/auth.mjs';
import {initUat} from '../../server/uat-cross-role.mjs';
import {createCrossRoleUatHandler} from '../../server/uat-cross-role-http.mjs';


const dir=await mkdtemp(path.join(os.tmpdir(),'aimoc-uat-browser-'));
const identity=await createEmbeddedDatabase(),uat=await createEmbeddedDatabase();
await bootstrap(identity,path.join(dir,'accounts.json'));
await provisionLocalDriverUat(identity,{localOnly:true,accessPath:path.join(dir,'driver-accounts.json')});
await initUat(uat);
const accounts=(await identity.query("SELECT id,username,role FROM aimoc_alfa_ops.users WHERE username IN ('admin','stock1','stock2','driver1')")).rows;
const sessions={};
for(const actor of accounts){
 const token='u'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
 await identity.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[hash(token),actor.id,'csrf-'+actor.username]);
 sessions[actor.username]=token;
}
const api=createCrossRoleUatHandler({identityDb:identity,uatDb:uat});
const server=http.createServer(async(req,res)=>{
 if(req.url.startsWith('/api'))return api(req,res);
 const url=new URL(req.url,'http://uat.local');
 const file=url.pathname.startsWith('/assets/')?
  path.join('.local/uat-web-dist',url.pathname.slice(1)):'.local/uat-web-dist/index.html';
 try{
  const bytes=await readFile(file);
  res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  res.end(bytes);
 }catch{res.writeHead(404);res.end('Not found')}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const chromePort=9700+Math.floor(Math.random()*300);
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
 '--headless','--disable-gpu','--no-first-run','--no-default-browser-check',
 '--remote-debugging-port='+chromePort,'--user-data-dir='+path.join(dir,'chrome'),'about:blank'
],{stdio:'ignore'});
let ws;const results=[],errors=[];
try{
 let tabs;
 for(let i=0;i<45;i++){
  try{tabs=await (await fetch('http://127.0.0.1:'+chromePort+'/json')).json();break}
  catch{await new Promise(resolve=>setTimeout(resolve,100))}
 }
 if(!tabs)throw Error('Chrome debug port not ready');
 ws=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);
 await new Promise(ok=>ws.addEventListener('open',ok,{once:true}));
 let seq=0;const pending=new Map();
 ws.onmessage=event=>{
  const v=JSON.parse(event.data);
  if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails.exception?.description||v.params.exceptionDetails.text);
  if(pending.has(v.id)){pending.get(v.id)(v);pending.delete(v.id);}
 };
 const send=(method,params={})=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async code=>{
  const r=await send('Runtime.evaluate',{expression:code,returnByValue:true,awaitPromise:true});
  if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
 };
 await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
 await mkdir('qa/cross-role-uat/screenshots',{recursive:true});
 for(const username of ['admin','stock1','stock2','driver1']){
  await send('Network.setCookie',{name:'alfa_session',value:sessions[username],url:origin,sameSite:'Strict'});
  await send('Emulation.setDeviceMetricsOverride',{width:username==='driver1'?390:1280,height:850,deviceScaleFactor:1,mobile:username==='driver1'});
  await send('Page.navigate',{url:origin+'/'});
  await new Promise(ok=>setTimeout(ok,1400));
  const v=JSON.parse(await evaluate("JSON.stringify({role:document.querySelector('.cross-role-heading>div>span')?.textContent,heading:document.querySelector('.cross-role-heading h1')?.textContent,form:!!document.querySelector('.cross-role-form'),source:document.querySelector('.cross-role-banner strong')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth+2,app:!!document.querySelector('.cross-role-shell')})"));
  if(username==='admin'){
   await evaluate("document.querySelector('.cross-role-form button[type=submit]').click();true");
   await new Promise(ok=>setTimeout(ok,500));
   const created=await evaluate("!!document.querySelector('.cross-role-trip')");
   if(!created)throw Error('Admin dispatch did not render in UAT browser');
   await evaluate("document.querySelector('.cross-role-next button')?.click();true");
   await new Promise(ok=>setTimeout(ok,350));
  }else{
   const shared=await evaluate("!!document.querySelector('.cross-role-trip')");
   if(!shared)throw Error(username+' did not see shared Admin UAT dispatch');
  }
  results.push({username,...v,sharedDispatchVisible:true});
  const shot=await send('Page.captureScreenshot',{format:'png'});
  if(shot.result?.data)await writeFile('qa/cross-role-uat/screenshots/'+username+'.png',Buffer.from(shot.result.data,'base64'));
  if(!v.app||v.overflow||v.form!==(username==='admin'))throw Error('Browser UAT mismatch '+JSON.stringify(v));
 }
 console.log(JSON.stringify({results,jsErrors:errors},null,2));
 if(errors.some(e=>!e.includes('WebSocket closed without opened')))process.exitCode=1;
}finally{
 ws?.close();
 chrome.kill();
 await Promise.race([new Promise(ok=>chrome.once('exit',ok)),new Promise(ok=>setTimeout(ok,1800))]);
 await new Promise(ok=>server.close(ok));
 await identity.close();await uat.close();
 await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
