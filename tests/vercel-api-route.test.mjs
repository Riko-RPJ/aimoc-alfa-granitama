import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {rewriteVercelApiUrl} from '../server/api-route.mjs';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {hash} from '../server/auth.mjs';

test('Vercel routing preserves query values and duplicates while removing its internal route key',()=>{
 const value=rewriteVercelApiUrl('/api/index?route=v1%2Fdemo%2Fsku-stock&transferMode=LAND&destinationCrusherId=crusher-2');
 assert.equal(value,'/api/v1/demo/sku-stock?transferMode=LAND&destinationCrusherId=crusher-2');
 const duplicate=new URL(rewriteVercelApiUrl('/api/index?route=v1/demo/sku-stock&transferMode=LAND&transferMode=MARINE'),'http://local');
 assert.deepEqual(duplicate.searchParams.getAll('transferMode'),['LAND','MARINE']);assert.equal(duplicate.searchParams.has('route'),false);
 assert.equal(rewriteVercelApiUrl('/api/health?check=1'),'/api/health?check=1');
});

test('Vercel-style rewrite retains LAND destination exclusion in the authenticated stock API',async()=>{
 const db=await createEmbeddedDatabase();let server;
 try{
  await bootstrap(db);
  const actor=(await db.query("SELECT id FROM aimoc_alfa_ops.users WHERE username='admin'")).rows[0],token='synthetic-vercel-session'.padEnd(43,'x');
  await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'csrf-test',now()+interval '1 hour')",[hash(token),actor.id]);
  const s=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
  for(const stock of s.stockpiles.filter(x=>x.skuId==='split-12')){stock.onHandM3=stock.crusherId==='crusher-1'?100:50;stock.reservedM3=stock.crusherId==='crusher-1'?10:20;}
  await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(s)]);
  const handler=createHandler(db);server=http.createServer((req,res)=>{req.url=rewriteVercelApiUrl(req.url);return handler(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/api/index?route=v1/demo/sku-stock&transferMode=LAND&destinationCrusherId=crusher-2',{headers:{Cookie:'alfa_session='+token}});
  assert.equal(response.status,200);const data=await response.json();assert.equal(data.transferMode,'LAND');assert.equal(data.destinationCrusherId,'crusher-2');
  const sku=data.items.find(x=>x.skuId==='split-12');assert.equal(sku.physicalTonnes,225);assert.equal(sku.sourceEligibleAvailableTonnes,135);
 }finally{if(server)await new Promise(r=>server.close(r));await db.close();}
});
