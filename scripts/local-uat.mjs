import http from 'node:http';
import net from 'node:net';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {createCrossRoleUatHandler} from '../server/uat-cross-role-http.mjs';
import {initUat} from '../server/uat-cross-role.mjs';
if(process.env.DATABASE_URL)throw Error('CROSS_ROLE_UAT_MUST_NOT_USE_PRODUCTION_DATABASE_URL');
// The normal dev server and UAT server must not open the same embedded
// identity database concurrently in different processes.
const normalServerRunning=await new Promise(resolve=>{
 const socket=net.connect({host:'127.0.0.1',port:4196});
 socket.once('connect',()=>{socket.destroy();resolve(true)});
 socket.once('error',()=>resolve(false));
 socket.setTimeout(600,()=>{socket.destroy();resolve(false)});
});
if(normalServerRunning)throw Error('Stop npm run dev on port 4196 before starting dev:uat; shared embedded identity DB cannot be opened twice.');
await mkdir('.local',{recursive:true});
const legacy=await createEmbeddedDatabase('.local/database');
const uat=await createEmbeddedDatabase('.local/cross-role-uat');
await initUat(uat);
const api=createCrossRoleUatHandler({identityDb:legacy,uatDb:uat});
process.env.VITE_CROSS_ROLE_UAT='1';
const vite=await createServer({server:{middlewareMode:true,host:'127.0.0.1'},appType:'spa'});
const port=Number(process.env.UAT_PORT||4296);
const server=http.createServer((req,res)=>req.url.startsWith('/api')?api(req,res):vite.middlewares(req,res));
server.listen(port,'127.0.0.1',()=>console.log('AIMOC isolated Cross-Role UAT: http://127.0.0.1:'+port+' — SIMULATION ONLY'));
const close=async()=>{server.close();await vite.close();await uat.close();await legacy.close();process.exit(0)};
process.on('SIGINT',close);process.on('SIGTERM',close);
