import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';

const admin={id:'quarry-erp-admin',role:'admin'},driver={id:'quarry-erp-driver',role:'driver',active:true};
function fixture(quantity=80,quarry=true){
  const state=createSeed(),options={drivers:[driver]};
  state.trucks=state.trucks.slice(0,1).map(truck=>({...truck,bedM3:30,payloadLimitT:40}));
  const act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);
  const created=act(quarry?'quarry.request.create':'request.create',{transferMode:'MARINE',destinationLocationId:state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity,unit:'t'}]});
  act(quarry?'quarry.dispatch.plan':'request.plan',{requestId:created.requestId});
  const ids=state.trips.filter(trip=>trip.requestId===created.requestId).sort((a,b)=>a.sequence-b.sequence).map(trip=>trip.id),trip=id=>state.trips.find(trip=>trip.id===id);
  const stock=id=>({id:'quarry-erp-stock',role:'stock',crusherIds:[trip(id).crusherId]}),jetty=id=>({id:'quarry-erp-jetty',role:'jetty',jettyIds:[trip(id).jettyId]});
  const gate=(id,purpose,extra={})=>act('quarry.gate.scan',{tripId:id,truckId:trip(id).truckId,laneId:purpose==='EXIT'?'lane-2':'lane-1',direction:purpose==='EXIT'?'OUT':'IN',purpose,qrValue:integratedView(state,admin,options).trips.find(trip=>trip.id===id).quarry.dispatchPass.value,externalEventId:randomUUID(),...extra},stock(id));
  const enter=(id,reuse=false)=>gate(id,'ENTRY',reuse?{laneId:'lane-3'}:{weightT:15});
  const depart=(id,extra={})=>{act('trip.loading',{tripId:id},stock(id));return gate(id,'EXIT',{weightT:15+trip(id).tonnageT,...extra});};
  const receive=id=>{act('trip.arrive',{tripId:id},jetty(id));act('trip.receive',{tripId:id},jetty(id));};
  const back=id=>gate(id,'RETURN',{laneId:'lane-3'});
  return {state,options,act,ids,trip,stock,jetty,gate,enter,depart,receive,back};
}

test('quarry ERP movement snapshots correlate the measured trip with distinct entry/exit lane versions and remain immutable',()=>{
  const f=fixture(40),id=f.ids[0];f.enter(id);
  const entry=f.trip(id).quarryGateEvents[0];
  f.act('quarry.config.save',{model:'STATIC_WIM'});
  f.depart(id,{laneId:'lane-1'});
  const trip=f.trip(id),exit=trip.quarryGateEvents[1],departure=f.state.erpOutbox[0],payload=departure.payload;
  assert.equal(departure.status,'awaiting_configuration');assert.equal(departure.synthetic,true);
  assert.equal(payload.workflow,'QUARRY_CILEGON');assert.equal(payload.quantitySource,'SCALE_SIMULATION');assert.equal(payload.physicalMeasurementVerified,false);
  assert.equal(payload.truckId,trip.truckId);assert.equal(payload.tareT,15);assert.equal(payload.grossT,55);assert.equal(payload.netT,40);assert.equal(payload.densityTPerM3,trip.densityTPerM3);
  assert.equal(payload.quarryEvidence.entry.gateEventId,entry.id);assert.equal(payload.quarryEvidence.entry.configVersion,entry.configVersion);assert.equal(payload.quarryEvidence.entry.mode,'WIM');
  assert.equal(payload.quarryEvidence.exit.gateEventId,exit.id);assert.equal(payload.quarryEvidence.exit.configVersion,exit.configVersion);assert.equal(payload.quarryEvidence.exit.mode,'STATIC');
  assert.ok(exit.configVersion>entry.configVersion);assert.deepEqual(payload.quarryEvidence.entry.laneSnapshot,entry.laneSnapshot);assert.deepEqual(payload.quarryEvidence.exit.laneSnapshot,exit.laneSnapshot);
  const preserved=structuredClone(payload);
  f.act('quarry.config.save',{model:'STATIC_STATIC'});f.receive(id);
  assert.deepEqual(f.state.erpOutbox[0].payload,preserved);
  const receipt=f.state.erpOutbox.find(row=>row.type==='stock_transfer_received').payload;
  assert.equal(receipt.receiptCode,f.trip(id).receiptCode);assert.deepEqual(receipt.quarryEvidence,preserved.quarryEvidence);
  assert.notStrictEqual(receipt.quarryEvidence,departure.payload.quarryEvidence);
  assert.notStrictEqual(receipt.quarryEvidence.entry.laneSnapshot,entry.laneSnapshot);
  const outboxBefore=structuredClone(f.state.erpOutbox);f.back(id);assert.deepEqual(f.state.erpOutbox,outboxBefore,'Return does not emit another stock movement');
});

test('ERP carries original measured tare and preceding-trip reuse provenance across serial QR entries',()=>{
  const f=fixture(120),originalId=f.ids[0];let originalTareEvent;
  for(const [index,id]of f.ids.entries()){
    f.enter(id,index>0);if(!index)originalTareEvent=f.trip(id).tareEventId;
    f.depart(id);f.receive(id);f.back(id);
    const rows=f.state.erpOutbox.filter(row=>row.entityId===id);assert.equal(rows.length,2);
    for(const {payload}of rows){
      const proof=payload.quarryEvidence.tare;
      assert.equal(proof.originalTripId,originalId);assert.equal(proof.originalEventId,originalTareEvent);assert.equal(proof.tareEventId,f.trip(id).tareEventId);
      assert.equal(proof.reused,index>0);assert.equal(proof.measurementKind,index?'DISPATCH_TARE_REUSE':'SCALE_SIMULATION');
      assert.equal(proof.sourceTripId,index?f.ids[index-1]:id);
      assert.equal(payload.quarryEvidence.entry.mode,index?'QR_ONLY':'WIM');assert.equal(payload.quantitySource,'SCALE_SIMULATION');assert.equal(payload.physicalMeasurementVerified,false);
    }
  }
  assert.equal(f.state.erpOutbox.length,6);assert.equal(f.state.inventoryLedger.length,6);assert.equal(f.state.vessels[0].loadedT,120);
});

test('failed departure rolls back the newly appended exit evidence and its ERP snapshot atomically',()=>{
  const f=fixture(40),id=f.ids[0];f.enter(id);f.act('trip.loading',{tripId:id},f.stock(id));
  f.state.stockpiles.find(pile=>pile.id===f.trip(id).stockpileId).onHandM3=0;
  const before=structuredClone(f.state);
  assert.throws(()=>f.gate(id,'EXIT',{weightT:55}),error=>error.code==='STOCK_CONFLICT');
  assert.deepEqual(f.state,before);assert.equal(f.trip(id).quarryGateEvents.length,1);assert.equal(f.state.erpOutbox.length,0);
});

test('legacy full-FSM ERP payload preserves its original quantity source and contains no quarry fields',()=>{
  const f=fixture(40,false),id=f.ids[0];
  f.act('trip.qr',{tripId:id});f.act('trip.start',{tripId:id},driver);f.act('trip.tare',{tripId:id,weightT:15},f.stock(id));f.act('trip.loading',{tripId:id},f.stock(id));f.act('trip.gross',{tripId:id,weightT:55},f.stock(id));f.act('trip.depart',{tripId:id},f.stock(id));f.receive(id);
  assert.equal(f.state.erpOutbox.length,2);
  for(const {payload}of f.state.erpOutbox){
    assert.equal(payload.quantitySource,'INTEGRATED_DEMO');
    for(const key of ['workflow','physicalMeasurementVerified','truckId','tareT','grossT','netT','densityTPerM3','quarryEvidence'])assert.equal(Object.hasOwn(payload,key),false,key);
  }
});
