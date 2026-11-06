import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction} from '../server/integrated-demo-domain.mjs';
import {applyStockpileLocationAction,deriveStockpileLocations,ensureReceivingStockpilesForRequest,resolveStockpileDestination} from '../server/stockpile-locations.mjs';

const admin={id:'synthetic-location-admin',role:'admin'};
const input=(name='Synthetic destination',transportModes=['MARINE'])=>({name,address:'Synthetic address',transportModes});
const edit=location=>({id:location.id,name:location.name,address:location.address,transportModes:location.transportModes});
const save=(state,payload)=>applyStockpileLocationAction(state,'master.stockpileLocation.save',payload,admin);

test('location code is generated, monotonic and unique across deletion and historical codes',()=>{
 const s=createSeed();
 const first=save(s,input('First')),second=save(s,input('Second'));
 assert.equal(first.locationCode,'SPL-000001');assert.equal(second.locationCode,'SPL-000002');
 applyStockpileLocationAction(s,'master.stockpileLocation.delete',{id:second.locationId},admin);
 assert.equal(save(s,input('After deletion')).locationCode,'SPL-000003');
 s.requests.push({id:'historical',destinationLocationCode:'spl-000011',status:'completed'});
 assert.equal(save(s,input('Above history')).locationCode,'SPL-000012');
 delete s.stockpileLocationSequence;
 assert.equal(save(s,input('Recover sequence')).locationCode,'SPL-000013');
 assert.equal(new Set(s.stockpileLocations.map(x=>x.code.toLowerCase())).size,s.stockpileLocations.length);
});

test('system code, active state and receiving mapping cannot be supplied or altered by clients',()=>{
 const s=createSeed(),before=structuredClone(s);
 for(const extra of [{code:'USER-CODE'},{active:false},{active:true},{receivingCrusherId:'crusher-2'},{receivingCrusherId:null}]){
  assert.throws(()=>save(s,{...input(),...extra}),e=>e.code==='STOCKPILE_LOCATION_MANAGED_FIELD');assert.deepEqual(s,before);
 }
 const created=save(s,input('Generated')),loc=s.stockpileLocations.find(x=>x.id===created.locationId);
 assert.equal(loc.active,true);assert.equal(loc.receivingCrusherId,null);
 for(const extra of [{code:loc.code},{active:loc.active},{receivingCrusherId:loc.receivingCrusherId}])assert.throws(()=>save(s,{...edit(loc),...extra}),e=>e.code==='STOCKPILE_LOCATION_MANAGED_FIELD');
});

test('editing preserves legacy manual codes, inactive flags, mapping and all existing balances',()=>{
 const s=createSeed(),loc=s.stockpileLocations[0];loc.code='LEGACY-MANUAL';loc.active=false;
 const before=structuredClone(s);
 save(s,{...edit(loc),name:'Renamed inactive legacy site',address:'Updated address'});
 const after=s.stockpileLocations.find(x=>x.id===loc.id);
 assert.equal(after.code,'LEGACY-MANUAL');assert.equal(after.active,false);assert.equal(after.receivingCrusherId,loc.receivingCrusherId);
 assert.deepEqual(s.stockpiles,before.stockpiles);assert.deepEqual(s.crushers,before.crushers);assert.deepEqual(s.inventoryLedger,before.inventoryLedger);assert.deepEqual(s.erpOutbox,before.erpOutbox);
});

test('new LAND location gets isolated zero-balance receiving inventory without claiming a physical crusher',()=>{
 const s=createSeed(),before=structuredClone(s),created=save(s,input('New road site',['LAND','MARINE']));
 const loc=s.stockpileLocations.find(x=>x.id===created.locationId),area=s.crushers.find(x=>x.id===loc.receivingCrusherId),stocks=s.stockpiles.filter(x=>x.crusherId===area.id);
 assert.notEqual(area.id,'crusher-1');assert.notEqual(area.id,'crusher-2');assert.equal(area.kind,'RECEIVING_AREA');assert.equal(area.production,false);assert.equal(area.sourceEligible,false);assert.equal(area.stockpileLocationId,loc.id);
 assert.equal(s.crushers.filter(x=>x.kind!=='RECEIVING_AREA'&&x.production!==false).length,before.crushers.length);
 assert.equal(stocks.length,s.products.filter(x=>x.active).length);assert.ok(stocks.every(x=>x.onHandM3===0&&x.reservedM3===0&&x.active&&x.managedBy==='STOCKPILE_LOCATION'));
 assert.deepEqual(s.stockpiles.filter(x=>before.stockpiles.some(b=>b.id===x.id)),before.stockpiles);assert.deepEqual(s.inventoryLedger,before.inventoryLedger);assert.deepEqual(s.erpOutbox,before.erpOutbox);
 assert.ok(area.code.length<=64&&stocks.every(x=>x.code.length<=64));
});

test('legacy long code can add LAND without generating overlong area or stockpile codes',()=>{
 const s=createSeed(),loc={id:'legacy-long-code',code:'L'.repeat(64),name:'Legacy marine',address:'',transportModes:['MARINE'],receivingCrusherId:null,active:true};s.stockpileLocations.push(loc);
 save(s,{...edit(loc),transportModes:['LAND','MARINE']});
 const updated=s.stockpileLocations.find(x=>x.id===loc.id),area=s.crushers.find(x=>x.id===updated.receivingCrusherId);
 assert.equal(updated.code,loc.code);assert.ok(area.code.length<=64);assert.ok(s.stockpiles.filter(x=>x.crusherId===area.id).every(x=>x.code.length<=64));
 assert.equal(resolveStockpileDestination(s,{transferMode:'LAND',destinationLocationId:loc.id,lines:[{skuId:'split-12'}]}).destinationId,area.id);
});

test('new automatic LAND receiving completes real demo custody to its own inventory, preserving vessel cargo',()=>{
 const s=createSeed(),driver={id:'synthetic-driver',role:'driver',active:true},options={drivers:[driver]};
 const act=(action,payload,actor=admin)=>applyIntegratedAction(s,action,payload,actor,options);
 const created=act('master.stockpileLocation.save',input('End-to-end receiver',['LAND'])),loc=s.stockpileLocations.find(x=>x.id===created.locationId);
 const target=s.stockpiles.find(x=>x.crusherId===loc.receivingCrusherId&&x.skuId==='split-12'),beforeCargo=s.vessels.map(v=>[v.loadedT,v.reservedT]);
 const request=act('request.create',{transferMode:'LAND',destinationLocationId:loc.id,lines:[{skuId:'split-12',quantity:9,unit:'t'}]});
 const plan=act('request.plan',{requestId:request.requestId,assignments:[{truckId:'truck-1',driverUserId:driver.id}]}),tripId=plan.tripIds[0];
 act('trip.qr',{tripId});act('trip.tare',{tripId,weightT:20});act('trip.start',{tripId},driver);act('trip.loading',{tripId});act('trip.gross',{tripId,weightT:29});act('trip.depart',{tripId});
 const receiver={id:'synthetic-receiver',role:'stock',crusherIds:[loc.receivingCrusherId]};act('trip.arrive',{tripId},receiver);act('trip.receive',{tripId},receiver);act('trip.return_start',{tripId},driver);act('trip.return',{tripId});
 assert.equal(s.stockpiles.find(x=>x.id===target.id).onHandM3,6);assert.deepEqual(s.vessels.map(v=>[v.loadedT,v.reservedT]),beforeCargo);
 assert.equal(s.requests.find(x=>x.id===request.requestId).status,'completed');assert.equal(s.trips.find(x=>x.id===tripId).destinationLocationId,loc.id);
 assert.equal(s.erpOutbox.filter(x=>x.entityId===tripId).length,2);
});

test('delete cleans only unused system-created zero inventory; balances and historical receiving are protected',()=>{
 const s=createSeed(),before=structuredClone(s),created=save(s,input('Unused road',['LAND']));
 applyStockpileLocationAction(s,'master.stockpileLocation.delete',{id:created.locationId},admin);
 assert.deepEqual(s.stockpiles,before.stockpiles);assert.deepEqual(s.crushers,before.crushers);
 const held=save(s,input('Stored material',['LAND'])),loc=s.stockpileLocations.find(x=>x.id===held.locationId);s.stockpiles.find(x=>x.crusherId===loc.receivingCrusherId).onHandM3=2;
 const snapshot=structuredClone(s);assert.throws(()=>applyStockpileLocationAction(s,'master.stockpileLocation.delete',{id:loc.id},admin),e=>e.code==='LOCATION_IN_USE');assert.deepEqual(s,snapshot);
});

test('invalid provisioning is atomic and legacy derivation never creates physical destinations from logical inventory',()=>{
 const s=createSeed();s.products.push({...s.products[0]});const before=structuredClone(s);
 assert.throws(()=>save(s,input('Invalid master',['LAND'])),e=>e.code==='STOCKPILE_LOCATIONS_STATE_INVALID');assert.deepEqual(s,before);
 const good=createSeed();save(good,input('Logical',['LAND']));delete good.stockpileLocations;
 assert.equal(deriveStockpileLocations(good).length,2);assert.ok(deriveStockpileLocations(good).every(loc=>['crusher-1','crusher-2'].includes(loc.receivingCrusherId)));
});

test('authorized LAND writes provision future active SKUs; destination reads remain pure and synchronization is idempotent',()=>{
 const s=createSeed(),created=save(s,input('Future SKU site',['LAND'])),loc=s.stockpileLocations.find(x=>x.id===created.locationId);
 s.products.push({...s.products[0],id:'synthetic-future-sku',code:'FUTURE-SKU'});
 const payload={transferMode:'LAND',destinationLocationId:loc.id,lines:[{skuId:'synthetic-future-sku',quantity:2,unit:'t'}]},before=structuredClone(s);
 assert.throws(()=>resolveStockpileDestination(s,payload),e=>e.code==='DESTINATION_STOCKPILE_REQUIRED');assert.deepEqual(s,before);
 const synced=ensureReceivingStockpilesForRequest(s,payload);
 assert.equal(synced.createdStockpileIds.length,1);assert.equal(synced.receivingAreaId,loc.receivingCrusherId);
 const row=s.stockpiles.find(x=>x.id===synced.createdStockpileIds[0]);assert.equal(row.skuId,'synthetic-future-sku');assert.equal(row.onHandM3,0);assert.equal(row.reservedM3,0);assert.equal(row.stockpileLocationId,loc.id);assert.ok(row.code.length<=64);
 assert.equal(resolveStockpileDestination(s,payload).destinationId,loc.receivingCrusherId);
 const after=structuredClone(s);assert.deepEqual(ensureReceivingStockpilesForRequest(s,payload).createdStockpileIds,[]);assert.deepEqual(s,after);
});

test('SKU synchronization never reactivates an existing inactive target or mutates physical legacy and MARINE destinations',()=>{
 const s=createSeed(),created=save(s,input('Inactive target site',['LAND'])),loc=s.stockpileLocations.find(x=>x.id===created.locationId);
 const payload={transferMode:'LAND',destinationLocationId:loc.id,lines:[{skuId:'split-12'}]};s.stockpiles.find(x=>x.crusherId===loc.receivingCrusherId&&x.skuId==='split-12').active=false;
 const before=structuredClone(s);assert.deepEqual(ensureReceivingStockpilesForRequest(s,payload).createdStockpileIds,[]);assert.deepEqual(s,before);assert.throws(()=>resolveStockpileDestination(s,payload),e=>e.code==='DESTINATION_STOCKPILE_REQUIRED');
 const legacy={transferMode:'LAND',destinationLocationId:s.stockpileLocations[0].id,lines:[{skuId:'unknown-sku'}]};assert.deepEqual(ensureReceivingStockpilesForRequest(s,legacy).createdStockpileIds,[]);assert.deepEqual(s,before);
 assert.deepEqual(ensureReceivingStockpilesForRequest(s,{transferMode:'MARINE',lines:null}).createdStockpileIds,[]);assert.deepEqual(s,before);
});

test('SKU synchronization rejects malformed and cross-owned receiving scope before creating any stock rows',()=>{
 const s=createSeed(),created=save(s,input('Scope protected',['LAND'])),loc=s.stockpileLocations.find(x=>x.id===created.locationId);
 s.products.push({...s.products[0],id:'new-sku',code:'NEW-SKU'});
 const payload={transferMode:'LAND',destinationLocationId:loc.id,lines:[{skuId:'new-sku'}]};
 for(const lines of [null,[null],[{skuId:'new-sku'},{skuId:'not-active'}]]){const before=structuredClone(s);assert.throws(()=>ensureReceivingStockpilesForRequest(s,{...payload,lines}));assert.deepEqual(s,before);}
 const area=s.crushers.find(x=>x.id===loc.receivingCrusherId);area.sourceEligible=true;
 let before=structuredClone(s);assert.throws(()=>ensureReceivingStockpilesForRequest(s,payload),e=>e.code==='STOCKPILE_LOCATIONS_STATE_INVALID');assert.deepEqual(s,before);
 area.sourceEligible=false;s.stockpileLocations.push({...s.stockpileLocations[0],id:'cross-owner',code:'CROSS-OWNER',receivingCrusherId:area.id});
 before=structuredClone(s);assert.throws(()=>ensureReceivingStockpilesForRequest(s,payload),e=>e.code==='STOCKPILE_LOCATIONS_STATE_INVALID');assert.deepEqual(s,before);
});
