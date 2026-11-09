import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {hash} from '../server/auth.mjs';

test('authenticated live context reflects submit, replay, plan and approve transitions without read side effects or cross-role counts',async t=>{
 const db=await createEmbeddedDatabase();await bootstrap(db);
 const driverId=randomUUID();await db.query("INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role) VALUES($1,'sidebar-driver','Synthetic sidebar driver','not-a-login-credential','driver')",[driverId]);
 const actors={};for(const user of (await db.query('SELECT id,username FROM aimoc_alfa_ops.users')).rows){const token=('sidebar-'+user.username).padEnd(43,'x');await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'sidebar-synthetic-csrf',now()+interval '1 hour')",[hash(token),user.id]);actors[user.username]={cookie:'alfa_session='+token};}
 const server=http.createServer(createHandler(db));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(path,method='GET',body,username='admin')=>{const response=await fetch(origin+path,{method,headers:{...(actors[username]?{Cookie:actors[username].cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':'sidebar-synthetic-csrf'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
 const read=async username=>{const response=await call('/api/v1/demo/context','GET',undefined,username);assert.equal(response.status,200);return response.body;};
 const command=async(action,payload,{username='admin',legacy=false,requestId=randomUUID()}={})=>{const result=await call(legacy?'/api/action':'/api/v1/demo/actions','POST',{action,payload,requestId},username);assert.equal(result.status,200,result.body.error);return result.body;};
 const snapshot=async()=>({operation:(await db.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0],actions:(await db.query('SELECT count(*)::int AS n FROM aimoc_alfa_ops.actions')).rows[0].n});
 assert.equal((await call('/api/v1/demo/context','GET',undefined,null)).status,401);
 const initial=await read('admin');assert.equal(initial.state.adminSidebarNotifications.counts.requests,0);assert.equal(initial.state.adminSidebarNotifications.counts.inventory,0);
 const key=randomUUID(),payload={transferMode:'MARINE',destinationLocationId:'stockpile-location-crusher-2',jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:10,unit:'t'}]};
 const submitted=await command('request.create',payload,{username:'jetty1',requestId:key});assert.equal(Object.hasOwn(submitted.state,'adminSidebarNotifications'),false);
 let current=await read('admin');assert.equal(current.state.adminSidebarNotifications.counts.requests,1);
 await command('request.create',payload,{username:'jetty1',requestId:key});assert.equal((await read('admin')).state.adminSidebarNotifications.counts.requests,1,'Command retry cannot duplicate a submission count');
 const plan=await command('request.plan',{requestId:submitted.result.requestId});assert.equal(plan.state.adminSidebarNotifications.counts.requests,0);
 const evidence=await call('/api/evidence','POST',{name:'notification-survey.png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='},'stock1');assert.equal(evidence.status,201);
 const measurement=await command('measurement.create',{stockpileId:'stock-1-3',skuId:'split-12',method:'manual',quantityValue:500,quantityUnit:'m3',evidenceId:evidence.body.id},{username:'stock1',legacy:true});assert.equal(Object.hasOwn(measurement.state,'adminSidebarNotifications'),false);
 current=await read('admin');assert.equal(current.state.adminSidebarNotifications.counts.inventory,1);assert.equal(current.state.adminSidebarNotifications.status,'READY');
 const beforeReads=await snapshot();for(const username of ['admin','stock1','stock2','jetty1','jetty2','sidebar-driver']){const context=await read(username);if(username!=='admin')assert.equal(Object.hasOwn(context.state,'adminSidebarNotifications'),false);}
 assert.deepEqual(await snapshot(),beforeReads,'Polling/navigation reads do not clear badges, write operation data or create action receipts');
 await command('measurement.approve',{measurementId:measurement.result.entityId},{legacy:true});current=await read('admin');assert.equal(current.state.adminSidebarNotifications.counts.inventory,0);
 for(const menu of ['overview','tasks','receiving','audit','master']){assert.equal(current.state.adminSidebarNotifications.counts[menu],0);assert.equal(current.state.adminSidebarNotifications.availability[menu],true);}
 assert.ok(current.state.erpOutbox.some(event=>event.status==='awaiting_configuration'));assert.equal(current.state.adminSidebarNotifications.counts.audit,0);
 assert.equal(Object.hasOwn((await snapshot()).operation.document,'adminSidebarNotifications'),false,'Projection is never stored in canonical operation JSON');
});
