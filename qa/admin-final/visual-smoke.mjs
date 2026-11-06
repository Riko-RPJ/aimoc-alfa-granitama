import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {extname,join,normalize} from 'node:path';
import {createEmbeddedDatabase} from '../../server/database.mjs';
import {createHandler} from '../../server/handler.mjs';
import {bootstrap} from '../../scripts/setup.mjs';
import {hash} from '../../server/auth.mjs';

const db=await createEmbeddedDatabase();
await bootstrap(db);
const session='qa'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
const user=(await db.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='admin'")).rows[0];
await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'uat-only-csrf',now()+interval '2 hours')",[hash(session),user.id]);
const handler=createHandler(db);
const web=http.createServer(async(req,res)=>{
 if(req.url.startsWith('/api'))return handler(req,res);
 const path=new URL(req.url,'http://qa.local').pathname;
 const file=path.startsWith('/assets/')?join('dist',normalize(path).replace(/^\/+/,'')):'dist/index.html';
 try{
  const bytes=await readFile(file);
  res.writeHead(200,{'Content-Type':extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'text/html'});
  res.end(bytes);
 }catch{res.writeHead(404);res.end('Not found');}
});
await new Promise(ok=>web.listen(0,'127.0.0.1',ok));
const port=web.address().port,remotePort=9700+Math.floor(Math.random()*400);
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
 '--headless','--disable-gpu','--no-first-run','--no-default-browser-check',
 '--remote-debugging-port='+remotePort,'--user-data-dir=/tmp/aimoc-final-admin-'+process.pid,'about:blank'
],{stdio:'ignore'});
let ws;
const errors=[],pages=[];
try{
 let tabs;
 for(let i=0;i<45;i++){
  try{tabs=await (await fetch('http://127.0.0.1:'+remotePort+'/json')).json();break}
  catch{await new Promise(ok=>setTimeout(ok,120))}
 }
 if(!tabs)throw Error('Chrome debugger not available');
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise(ok=>ws.addEventListener('open',ok,{once:true}));
 const pending=new Map();let seq=0;
 ws.onmessage=event=>{
  const data=JSON.parse(event.data);
  if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description||data.params.exceptionDetails.text);
  if(pending.has(data.id)){pending.get(data.id)(data);pending.delete(data.id)}
 };
 const send=(method,params={})=>new Promise(ok=>{const id=++seq;pending.set(id,ok);ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async code=>{
  const v=await send('Runtime.evaluate',{expression:code,returnByValue:true,awaitPromise:true});
  if(v.result?.exceptionDetails)throw Error(JSON.stringify(v.result.exceptionDetails));
  return v.result?.result?.value;
 };
 await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
 await send('Network.setCookie',{name:'alfa_session',value:session,url:'http://127.0.0.1:'+port,sameSite:'Strict'});
 await mkdir('qa/admin-final/screenshots',{recursive:true});
 const paths=['overview','requests','dispatchPlanning','dispatchMonitoring','inventory','exceptions','jetty','master','integrations','access'];
 for(const width of [1440,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
  await send('Page.navigate',{url:'http://127.0.0.1:'+port+'/admin/overview'});
  await new Promise(ok=>setTimeout(ok,1300));
  for(const page of paths){
   const path=await evaluate('JSON.stringify([...document.querySelectorAll(".sidebar nav button")].map(b=>({text:b.textContent,selected:b.classList.contains("selected")})))');
   // Mobile sidebar can be closed, but programmatic click remains valid for route smoke.
   const click=await evaluate('(()=>{const b=[...document.querySelectorAll(".sidebar nav button")].find(x=>x.textContent.includes('+JSON.stringify({
    overview:'Operations Overview',requests:'Transfer Requests',dispatchPlanning:'Dispatch Planning',dispatchMonitoring:'Trip Monitoring',
    inventory:'Inventory',exceptions:'Exceptions',jetty:'Jetty',master:'Master Data',
    integrations:'Integrations & Audit',access:'Role & Access Control'
   }[page])+'));if(!b)return false;b.click();return true})()');
   if(!click)throw Error('Navigation missing '+page+' '+path);
   await new Promise(ok=>setTimeout(ok,90));
   const snapshot=JSON.parse(await evaluate('JSON.stringify({heading:document.querySelector("h1")?.textContent, rendered:!!document.querySelector("[data-admin-final-page]"), id:document.querySelector("[data-admin-final-page]")?.getAttribute("data-admin-final-page"), horizontalOverflow:document.documentElement.scrollWidth>innerWidth+2, width:innerWidth,scrollWidth:document.documentElement.scrollWidth})'));
   if(snapshot.id!==page)throw Error('Wrong page '+page+' '+JSON.stringify(snapshot));
   pages.push({width,page,...snapshot});
   if(['overview','dispatchMonitoring','exceptions','access'].includes(page)){
    const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    if(screenshot.result?.data)await writeFile('qa/admin-final/screenshots/admin-'+page+'-'+width+'.png',Buffer.from(screenshot.result.data,'base64'));
   }
  }
 }
 console.log(JSON.stringify({pages:pages.length,failedOverflow:pages.filter(x=>x.horizontalOverflow),jsErrors:errors,headings:pages.filter(x=>x.width===1440).map(x=>({page:x.page,title:x.heading}))},null,2));
 if(errors.length||pages.some(x=>x.horizontalOverflow))process.exitCode=1;
}finally{
 ws?.close();chrome.kill();
 await new Promise(ok=>web.close(ok));await db.close();
}
