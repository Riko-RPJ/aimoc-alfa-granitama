import {createDatabase} from '../server/database.mjs';
import {createHandler} from '../server/handler.mjs';
import {rewriteVercelApiUrl} from '../server/api-route.mjs';
let handler;
export default async function api(req,res) {
 req.url=rewriteVercelApiUrl(req.url);
  try{handler??=createHandler(createDatabase(),{secure:true});await handler(req,res);}
  catch{res.statusCode=503;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'DATABASE_UNAVAILABLE',message:'Penyimpanan belum tersedia. Hubungi Admin AIMOC.'}));}
}
