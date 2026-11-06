import {createHandler} from './handler.mjs';
import {cookieValue,hash,userView} from './auth.mjs';
import {uatContext,createUatDispatch,advanceUat} from './uat-cross-role.mjs';

const reject=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
export function createCrossRoleUatHandler({identityDb,uatDb}){
 if(!identityDb||!uatDb||identityDb===uatDb)throw Error('ISOLATED_UAT_DB_REQUIRED');
 const legacy=createHandler(identityDb);
 return async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
  if(!path.startsWith('/api/uat/'))return legacy(req,res);
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-AIMOC-UAT':'SIMULATED'});res.end(JSON.stringify(data))};
  try{
   const cookie=cookieValue(req);
   const user=cookie?(await identityDb.query("SELECT u.*,s.csrf_token FROM aimoc_alfa_ops.sessions s JOIN aimoc_alfa_ops.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true",[hash(cookie)])).rows[0]:null;
   if(!user)reject(401,'AUTH_REQUIRED','Local UAT login required');
   const actor=userView(user);
   if(!['admin','stock','driver'].includes(actor.role))reject(403,'UAT_ROLE_FORBIDDEN','Role not part of this UAT workflow');
   if(method==='GET'&&path==='/api/uat/context')return send(200,await uatContext(uatDb,identityDb,actor));
   if(method!=='POST')reject(404,'ROUTE_NOT_FOUND','Unknown UAT endpoint');
   const origin=req.headers.origin;
   if(!origin||new URL(origin).host!==req.headers.host)reject(403,'ORIGIN_FORBIDDEN','Same-origin UAT action required');
   if(req.headers['x-csrf-token']!==user.csrf_token)reject(403,'CSRF_DENIED','Invalid session CSRF');
   if(!String(req.headers['content-type']||'').startsWith('application/json'))reject(415,'JSON_REQUIRED','JSON required');
   const chunks=[];let total=0;
   for await(const chunk of req){total+=chunk.length;if(total>16384)reject(413,'BODY_TOO_LARGE','UAT command too large');chunks.push(chunk)}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{reject(400,'INVALID_JSON','Invalid JSON')}
   if(!body||typeof body!=='object'||Array.isArray(body))reject(400,'INVALID_BODY','Object required');
   const key=req.headers['idempotency-key'];
   if(path==='/api/uat/dispatches')return send(200,await createUatDispatch(uatDb,identityDb,{actor,key,body}));
   const match=/^\/api\/uat\/trips\/(uat-[a-f0-9-]{36})\/actions$/.exec(path);
   if(match)return send(200,await advanceUat(uatDb,{actor,key,tripId:match[1],body}));
   reject(404,'ROUTE_NOT_FOUND','No matching UAT route');
  }catch(e){
   const status=e.status||500;
   send(status,{error:status>=500?'INTERNAL_ERROR':e.code||'UAT_REJECTED',
    message:status>=500?'UAT command failed':e.message});
  }
 };
}
