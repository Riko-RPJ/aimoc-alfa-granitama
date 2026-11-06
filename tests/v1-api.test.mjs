import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {passwordHash} from '../server/auth.mjs';

test('v1 authenticated read-only façade remains scoped and never invents evidence',async t=>{
  const db=await createEmbeddedDatabase();
  await bootstrap(db);
  const password='Phase4-UAT-Only-No-Real-Credentials!';
  await db.query('UPDATE aimoc_alfa_ops.users SET password_hash=$1',[await passwordHash(password)]);
  const server=http.createServer(createHandler(db));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  async function call(path,method='GET',body,auth={}){
    const r=await fetch(base+path,{method,headers:{
      ...(method!=='GET'?{'Content-Type':'application/json',Origin:base}:{}),
      ...(auth.cookie?{Cookie:auth.cookie}:{}),...(auth.csrf?{'X-CSRF-Token':auth.csrf}:{}),
    },body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')};
  }
  async function login(name){const r=await call('/api/login','POST',{username:name,password});assert.equal(r.status,200);
    return {cookie:r.cookie.split(';')[0],csrf:r.body.csrfToken};}
  try{
    const admin=await login('admin'),stock=await login('stock1'),jetty=await login('jetty1');
    await t.test('auth required and scoped session',async()=>{
      assert.equal((await call('/api/v1/inventory')).status,401);
      const s=await call('/api/v1/session','GET',undefined,stock);
      assert.equal(s.status,200);assert.equal(s.body.data.role,'STOCKPILE');
      assert.deepEqual(s.body.data.location_scope.crusher_ids,['crusher-1']);
    });
    await t.test('inventory exposes legacy m3 without falsely asserting verified tonnage',async()=>{
      const a=await call('/api/v1/inventory','GET',undefined,admin);
      const s=await call('/api/v1/inventory','GET',undefined,stock);
      assert.equal(a.status,200);assert.equal(a.body.data.items.length,12);
      assert.equal(s.status,200);assert.equal(s.body.data.items.length,6);
      assert.ok(s.body.data.items.every(x=>x.source_crusher_id==='crusher-1'));
      assert.ok(s.body.data.items.every(x=>x.on_hand_t===null&&x.reserved_t===null));
      assert.ok(s.body.data.items.every(x=>x.legacy_quantity.unit==='m3'));
      assert.equal((await call('/api/v1/inventory','GET',undefined,jetty)).status,403);
    });
    await t.test('admin permissions and missing evidence semantics',async()=>{
      assert.equal((await call('/api/v1/master-data','GET',undefined,stock)).status,403);
      assert.equal((await call('/api/v1/transfer-requests','GET',undefined,stock)).status,403);
      assert.equal((await call('/api/v1/dispatches','GET',undefined,stock)).status,403);
      assert.equal((await call('/api/v1/operations/overview','GET',undefined,jetty)).status,403);
      const m=await call('/api/v1/master-data','GET',undefined,admin);
      assert.equal(m.status,200);assert.equal(m.body.data.drivers,null);
      const ex=await call('/api/v1/exceptions','GET',undefined,admin);
      assert.equal(ex.body.data_status,'NOT_INTEGRATED');
      const sr=await call('/api/v1/stockpile/me/receipts','GET',undefined,stock);
      assert.equal(sr.body.data_status,'NOT_INTEGRATED');
      assert.equal(sr.body.data,null);
    });
    await t.test('target v1 mutations never fallback to legacy /api/action',async()=>{
      const before=await call('/api/state','GET',undefined,admin);
      const r=await call('/api/v1/dispatches/plan','POST',{mode:'MARINE',idempotency_key:randomUUID()},admin);
      assert.equal(r.status,501);assert.equal(r.body.error,'V1_COMMAND_NOT_INTEGRATED');
      const w=await call('/api/v1/integrations/weighbridge/events','POST',{event_type:'TARE_RECORDED'},admin);
      assert.equal(w.status,501);
      const after=await call('/api/state','GET',undefined,admin);
      assert.equal(after.body.revision,before.body.revision);
      assert.deepEqual(after.body.state.trips,before.body.state.trips);
    });
    await t.test('pagination is explicit and invalid values fail',async()=>{
      const r=await call('/api/v1/inventory/movements','GET',undefined,stock);
      assert.equal(r.status,200);
      assert.equal((await call('/api/v1/dispatches?limit=10000','GET',undefined,admin)).status,400);
      assert.equal((await call('/api/v1/transfer-requests?cursor=bad','GET',undefined,admin)).status,400);
    });
    await t.test('legacy mutation still works with existing session and CSRF',async()=>{
      const r=await call('/api/action','POST',{action:'request.create',requestId:randomUUID(),payload:{
        destinationLocationId:'stockpile-location-crusher-2',jettyId:'jetty-1',vesselId:'vessel-1',destination:'Untrusted text ignored',
        lines:[{skuId:'split-12',quantity:1,unit:'m3'}]}},jetty);
      assert.equal(r.status,200);
      const list=await call('/api/v1/transfer-requests','GET',undefined,admin);
      assert.equal(list.body.data.items.length,1);
      // Legacy transfer requests now have an explicit MARINE default mode.
      assert.equal(list.body.data.items[0].mode,'MARINE');
      assert.equal(list.body.data.items[0].destination_allocations,null);
    });
  } finally {await new Promise(resolve=>server.close(resolve));await db.close();}
});
