import {createDatabase} from '../server/database.mjs';
import {createHandler} from '../server/handler.mjs';
let handler;
export default async function api(req,res) {
  const route=new URL(req.url,'https://local.invalid').searchParams.get('route');
  if(route)req.url='/api/'+route;
  try{handler??=createHandler(createDatabase(),{secure:true});await handler(req,res);}
  catch{res.statusCode=503;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'DATABASE_UNAVAILABLE',message:'Penyimpanan belum tersedia. Hubungi Admin AIMOC.'}));}
}
