import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {hash} from '../server/auth.mjs';

async function fixture(t){
 const db=await createEmbeddedDatabase();await bootstrap(db);
 const s=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
 s.products.find(x=>x.id==='split-12').densityTPerM3=1.5;
 s.stockpiles=[
  {id:'qa-pile-a',code:'QA-A',crusherId:'crusher-1',skuId:'split-12',onHandM3:100,reservedM3:10,active:true},
  {id:'qa-pile-b',code:'QA-B',crusherId:'crusher-2',skuId:'split-12',onHandM3:50,reservedM3:20,active:true},
  {id:'qa-other',code:'QA-OTHER',crusherId:'crusher-2',skuId:'abu-batu',onHandM3:999,reservedM3:0,active:true}
 ];
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb,revision=7 WHERE id=1',[JSON.stringify(s)]);
 await db.query("INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role) VALUES($1,'qa-driver','Synthetic QA Driver','not-a-login-credential','driver')",[randomUUID()]);
 const users=(await db.query('SELECT id,username FROM aimoc_alfa_ops.users')).rows;
 for(const u of users){
  await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-csrf',now()+interval '1 hour')",[hash(u.username.padEnd(43,'x')),u.id]);
 }
 const server=http.createServer(createHandler(db));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
 const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,user='admin',method='GET')=>{
  const response=await fetch(base+path,{method,headers:{...(user?{Cookie:'alfa_session='+user.padEnd(43,'x')}:{}),...(method!=='GET'?{Origin:base,'Content-Type':'application/json','X-CSRF-Token':'synthetic-csrf'}:{})},...(method!=='GET'?{body:'{}'}:{})});
  return {status:response.status,body:await response.json(),headers:response.headers};
 };
 const read=async(user='admin',query='transferMode=MARINE')=>{
  const r=await call('/api/v1/demo/sku-stock?'+query,user);assert.equal(r.status,200,JSON.stringify(r.body));return r;
 };
 const stock=r=>{const item=r.body.items.find(x=>x.skuId==='split-12');assert.ok(item,'Selected SKU exists in authoritative summary');return item;};
 return {db,call,read,stock};
}

test('requester API reports global same-SKU physical tonnes without widening operator stock scopes',async t=>{
 const {db,call,read,stock}=await fixture(t);
 const before=(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 assert.equal((await call('/api/v1/demo/sku-stock?transferMode=MARINE',null)).status,401);
 const admin=await read(),jetty=await read('jetty1');
 for(const response of [admin,jetty]){
  const row=stock(response);
  assert.equal(row.physicalM3,150);assert.equal(row.physicalTonnes,225);
  assert.equal(row.reservedM3,30);assert.equal(row.reservedTonnes,45);
  assert.equal(row.availableM3,120);assert.equal(row.availableTonnes,180);
  assert.equal(row.sourceEligibleAvailableTonnes,180);
  assert.equal(row.stockpileCount,2);assert.equal(row.status,'READY');
  assert.equal('stockpiles' in row,false);assert.equal('stockpileIds' in row,false);
  assert.equal(response.body.revision,7);assert.match(response.headers.get('cache-control'),/no-store/);
 }
 const jettyContext=await call('/api/v1/demo/context','jetty1');
 assert.deepEqual(jettyContext.body.state.stockpiles,[]);
 const scopedStock=await call('/api/v1/demo/context','stock1');
 assert.ok(scopedStock.body.state.stockpiles.every(x=>x.crusherId==='crusher-1'));
 for(const user of ['stock1','stock2','qa-driver'])assert.equal((await call('/api/v1/demo/sku-stock?transferMode=MARINE',user)).status,403,user+' cannot read requester global totals');
 const after=(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 assert.deepEqual(after,before,'Read-only totals never change operation data/revision');
 assert.equal((await db.query('SELECT count(*)::int AS count FROM aimoc_alfa_ops.actions')).rows[0].count,0);
});

test('LAND totals preserve global physical stock while excluding destination from eligible source capacity',async t=>{
 const {db,call,read,stock}=await fixture(t);
 const before=(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 const row=stock(await read('admin','transferMode=LAND&destinationCrusherId=crusher-2'));
 assert.equal(row.physicalTonnes,225);assert.equal(row.reservedTonnes,45);assert.equal(row.availableTonnes,180);
 assert.equal(row.sourceEligibleAvailableM3,90);assert.equal(row.sourceEligibleAvailableTonnes,135);assert.equal(row.eligibleStockpileCount,1);
 assert.equal((await call('/api/v1/demo/sku-stock?transferMode=LAND&destinationCrusherId=crusher-2','jetty1')).status,403);
 const missing=stock(await read('admin','transferMode=LAND'));
 assert.equal(missing.physicalTonnes,225);assert.equal(missing.sourceEligibilityStatus,'DESTINATION_REQUIRED');assert.equal(missing.sourceEligibleAvailableTonnes,null);
 assert.equal((await call('/api/v1/demo/sku-stock?transferMode=TELEPORT')).status,400);
 const unknown=await call('/api/v1/demo/sku-stock?transferMode=LAND&destinationCrusherId=not-a-location');assert.ok(unknown.status>=400&&unknown.status<500);
 assert.equal((await call('/api/v1/demo/sku-stock?transferMode=MARINE','admin','POST')).status,405);
 assert.deepEqual((await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0],before);
});

test('fresh reads track canonical stock revisions and invalid density stays unavailable rather than becoming zero',async t=>{
 const {db,read,stock}=await fixture(t);
 assert.equal(stock(await read()).physicalTonnes,225);
 let document=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
 document.stockpiles.find(x=>x.id==='qa-pile-b').onHandM3=200;
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb,revision=revision+1,updated_at=now() WHERE id=1',[JSON.stringify(document)]);
 const fresh=await read('jetty2');assert.equal(fresh.body.revision,8);
 assert.equal(stock(fresh).physicalTonnes,450);assert.equal(stock(fresh).reservedTonnes,45);assert.equal(stock(fresh).availableTonnes,405);
 document.products.find(x=>x.id==='split-12').densityTPerM3=0;
 await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb,revision=revision+1 WHERE id=1',[JSON.stringify(document)]);
 const unavailable=await read(),row=stock(unavailable);
 assert.equal(unavailable.body.revision,9);assert.equal(row.physicalM3,300);assert.equal(row.physicalTonnes,null);assert.equal(row.reservedTonnes,null);assert.equal(row.availableTonnes,null);
 assert.equal(row.status,'INVALID_DATA');assert.ok(row.issues.includes('INVALID_DENSITY'));
 assert.equal(row.sourceEligibleAvailableTonnes,null);
 assert.equal((await db.query('SELECT revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].revision,9);
});
