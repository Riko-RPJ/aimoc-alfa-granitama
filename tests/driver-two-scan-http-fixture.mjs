import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {createHandler} from '../server/handler.mjs';
import {hash} from '../server/auth.mjs';

/** Fully isolated local PostgreSQL-compatible DB and the actual HTTP handler. */
export async function fixture(t,{mode='MARINE',quantity=80,secondRequest=true}={}){
 const db=await createEmbeddedDatabase();await bootstrap(db);
 const driverAId=randomUUID(),driverBId=randomUUID();
 for(const [id,username]of [[driverAId,'qa-driver-a'],[driverBId,'qa-driver-b']])await db.query("INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role) VALUES($1,$2,$2,'synthetic-unused-hash','driver')",[id,username]);
 const actors={};
 for(const user of(await db.query('SELECT id,username,role FROM aimoc_alfa_ops.users')).rows){const session=('two-scan-'+user.username).padEnd(43,'x');await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'qa-csrf',now()+interval '1 hour')",[hash(session),user.id]);actors[user.username]={id:user.id,role:user.role,cookie:'alfa_session='+session};}
 const row=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];row.document.trucks=row.document.trucks.slice(0,1).map(x=>({...x,bedM3:30,payloadLimitT:40}));row.document.vessels[0].status='loading';await db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb WHERE id=1',[JSON.stringify(row.document)]);
 const server=http.createServer(createHandler(db));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await db.close();});const origin='http://127.0.0.1:'+server.address().port;
 const call=async(path,method='GET',body,user='admin')=>{const actor=actors[user]||{};const response=await fetch(origin+path,{method,headers:{...(actor.cookie?{Cookie:actor.cookie}:{}),...(method!=='GET'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':'qa-csrf'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 const action=(action,payload,user='admin',extras={})=>call('/api/v1/demo/actions','POST',{action,payload,requestId:randomUUID(),...extras},user);
 const ok=async(actionName,payload,user='admin',extras={})=>{const r=await action(actionName,payload,user,extras);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 const state=async()=>(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
 const assignment=async(id,user='qa-driver-a')=>{const r=await call('/api/v1/demo/trips/'+id+'/assignment-qr','GET',undefined,user);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 const payload=(id,stage,wire,extras={})=>({tripId:id,qrValue:wire.qr.value,binding:wire.binding,expectedStage:stage,externalEventId:randomUUID(),...(stage===2?{confirmations:{materialReceived:true,truckReturned:true}}:{}),...extras});
 let locationId='stockpile-location-crusher-2';
 if(mode==='LAND'){const saved=await ok('master.stockpileLocation.save',{name:'Synthetic two-scan receiving stockpile',address:'Local QA fixture',transportModes:['LAND']});locationId=saved.result.locationId;}
 const create=async amount=>{const result=await ok('request.create',{transferMode:mode,destinationLocationId:locationId,...(mode==='MARINE'?{jettyId:'jetty-1',vesselId:'vessel-1'}:{}),lines:[{skuId:'split-12',quantity:amount,unit:'t'}]});await ok('request.plan',{requestId:result.result.requestId});return result.result.requestId;};
 const requestA=await create(quantity),requestB=secondRequest?await create(10):null;
 const prepared=await state(),tripsA=prepared.document.trips.filter(x=>x.requestId===requestA).sort((a,b)=>a.sequence-b.sequence);
 assert.ok(tripsA.every(x=>x.assignedDriverUserId===driverAId),'One Driver owns this dispatch serial queue');
 return {db,actors,call,action,ok,state,assignment,payload,requestA,requestB,tripsA,driverAId,driverBId};
}

export function business(document){const copy=structuredClone(document);delete copy.updatedAt;return copy;}
export const trip=(document,id)=>document.trips.find(x=>x.id===id);
