import {createHandler} from '../handler.mjs';
import {hash,userView,cookieValue} from '../auth.mjs';
import {stagingV1} from './staging-api.mjs';

const reject=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const raw=async(req,limit=65536)=>{
 let parts=[],total=0;
 for await(const chunk of req){total+=chunk.length;if(total>limit)reject(413,'PAYLOAD_TOO_LARGE','Request size exceeded');parts.push(chunk);}
 return Buffer.concat(parts).toString('utf8');
};
/**
 * Separate HTTP handler for explicitly provisioned local/staging use only.
 * Requires two independent DB connections; never used by production startup.
 * Legacy DB handles login/session; v1 execution DB holds transactional target state.
 */
export function createStagingApiHandler({legacyDb,executionDb,sourceSecrets={}}){
 if(!legacyDb||!executionDb||legacyDb===executionDb)throw Error('SEPARATE_STAGING_DB_REQUIRED');
 const legacy=createHandler(legacyDb);
 return async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',
   'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  const url=new URL(req.url,'http://staging.local'),path=url.pathname.replace(/\/$/,'');
  const method=req.method;
  if(!path.startsWith('/api/v1/')||path==='/api/v1/session')return legacy(req,res);
  try{
   const sourceRequest=path==='/api/v1/integrations/weighbridge/events'&&method==='POST';
   if(sourceRequest){
     if(!String(req.headers['content-type']||'').startsWith('application/json'))
       reject(415,'CONTENT_TYPE','JSON required');
     const rawBody=await raw(req,32768);
     const value=await stagingV1({db:executionDb,actor:null,req,path,method,rawBody,sourceSecrets});
     return send(value.data?.status==='REJECTED'?422:202,value);
   }
   const cookie=cookieValue(req);
   const row=cookie&&(await legacyDb.query(
     'SELECT u.*,s.csrf_token FROM aimoc_alfa_ops.sessions s JOIN aimoc_alfa_ops.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true',[hash(cookie)])).rows[0];
   if(!row)reject(401,'AUTH_REQUIRED','Session required');
   if(!['GET','HEAD'].includes(method)){
     const origin=req.headers.origin,host=req.headers.host;
     if(!origin||!host||new URL(origin).host!==host)reject(403,'ORIGIN_REJECTED','Same-origin command required');
     if(!String(req.headers['content-type']||'').startsWith('application/json'))
       reject(415,'CONTENT_TYPE','JSON required');
     if(req.headers['x-csrf-token']!==row.csrf_token)reject(403,'CSRF_REJECTED','CSRF token mismatch');
   }
   let body={};
   if(!['GET','HEAD'].includes(method)){
     const bytes=await raw(req);
     try{body=JSON.parse(bytes)}catch{reject(400,'INVALID_JSON','Valid JSON required');}
   }
   const result=await stagingV1({db:executionDb,actor:userView(row),req,path,method,body,sourceSecrets});
   if(!result)reject(404,'RESOURCE_NOT_FOUND','Staging v1 route not available');
   return send(method==='POST'?200:200,result);
  }catch(error){
   const status=error.status||error.statusCode||500;
   return send(status,{error:status>=500&&status!==501?'INTERNAL_ERROR':error.code||'REQUEST_REJECTED',
    message:status>=500&&status!==501?'Staging request failed':String(error.message||'Request rejected').slice(0,240)});
  }
 };
}
