import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {provisionLocalDriverUat} from '../scripts/local-driver-uat.mjs';
import {createHandler} from '../server/handler.mjs';

test('all local role logins authenticate, and Driver cannot access legacy data',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'aimoc-role-'));
  const db=await createEmbeddedDatabase();
  let server;
  try{
    await bootstrap(db,path.join(dir,'users.json'));
    const driverPath=path.join(dir,'drivers.json');
    const first=await provisionLocalDriverUat(db,{localOnly:true,accessPath:driverPath});
    assert.equal(first.created,2);
    assert.equal((await provisionLocalDriverUat(db,{localOnly:true,accessPath:driverPath})).created,0);
    await assert.rejects(()=>provisionLocalDriverUat(db,{localOnly:false}),/LOCAL_DRIVER_UAT_REQUIRES_EMBEDDED_DB/);
    const originals=JSON.parse(await readFile(path.join(dir,'users.json'),'utf8')).users;
    const drivers=JSON.parse(await readFile(driverPath,'utf8')).users;
    assert.equal(originals.length,5);
    assert.equal(drivers.length,2);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM aimoc_alfa_ops.users')).rows[0].count,7);
    server=http.createServer(createHandler(db));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    const send=async(route,method='GET',body,cookie,csrf)=>{
      const response=await fetch(base+route,{method,headers:{
        ...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:base,'Content-Type':'application/json'}:{}),
        ...(csrf?{'X-CSRF-Token':csrf}:{})},
        body:body===undefined?undefined:JSON.stringify(body)});
      return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
    };
    for(const account of [...originals,...drivers]){
      const login=await send('/api/login','POST',{username:account.username,password:account.password});
      assert.equal(login.status,200,account.username+' login failed');
      assert.equal(login.data.user.role,account.role);
      const cookie=login.cookie.split(';')[0];
      const me=await send('/api/me','GET',undefined,cookie);
      assert.equal(me.data.user.username,account.username);
      if(account.role==='driver'){
        assert.equal((await send('/api/state','GET',undefined,cookie)).status,403);
        assert.equal((await send('/api/v1/inventory','GET',undefined,cookie)).status,403);
        assert.equal((await send('/api/users','GET',undefined,cookie)).status,403);
        assert.equal((await send('/api/action','POST',
          {action:'request.create',requestId:'uat-attempt-1',payload:{}},
          cookie,login.data.csrfToken)).status,403);
        const driver=await send('/api/v1/driver/me/active-trip','GET',undefined,cookie);
        assert.equal(driver.status,200);
        assert.equal(driver.data.data_status,'NOT_INTEGRATED');
        assert.equal(driver.data.data,null);
      } else {
        assert.equal((await send('/api/state','GET',undefined,cookie)).status,200);
      }
      assert.equal((await send('/api/logout','POST',{},cookie,login.data.csrfToken)).status,200);
    }
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    await db.close();
    await rm(dir,{recursive:true,force:true});
  }
});
