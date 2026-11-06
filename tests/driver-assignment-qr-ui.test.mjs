import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction, integratedView} from '../server/integrated-demo-domain.mjs';
import {driverAssignmentQr} from '../server/driver-assignment-qr.mjs';
import {buildDriverScanIntent, driverAssignmentIdentity, driverScanStage, selectDriverAssignmentQr} from '../src/features/integrated/driver-assignment-qr.mjs';

function fixture() {
  const state = createSeed(), admin = {id: 'qr-ui-admin', role: 'admin'}, driver = {id: 'qr-ui-driver', username: 'qr-ui-driver', role: 'driver', active: true}, options = {drivers: [driver]};
  state.trucks = [{...state.trucks[0], bedM3: 30, payloadLimitT: 40}];
  state.vessels[0].status = 'loading';
  const requestId = applyIntegratedAction(state, 'request.create', {transferMode: 'MARINE', destinationLocationId: 'stockpile-location-crusher-2', jettyId: 'jetty-1', vesselId: 'vessel-1', lines: [{skuId: 'split-12', quantity: 80, unit: 't'}]}, admin, options).requestId;
  applyIntegratedAction(state, 'request.plan', {requestId}, admin, options);
  const expected = integratedView(state, driver, options).trips[0];
  return {state,options,expected,driver,data:driverAssignmentQr(state,driver,{tripId:expected.id,drivers:options.drivers})};
}

test('Driver QR frontend accepts the real server DTO only for the exact current assignment without mutating either snapshot', () => {
  const {data, expected, driver} = fixture(), before = structuredClone({data, expected});
  const selected = selectDriverAssignmentQr(data, expected, driver.id);
  assert.equal(selected.trip.id, expected.id); assert.equal(selected.qr.value, data.qr.value);
  assert.equal(Object.hasOwn(selected,'canOpenTask'),false);assert.equal(selected.historical,false);
  assert.equal(driverScanStage(selected),1);assert.equal(selected.driverScan.phase,'FIRST_SCAN_READY');
  assert.equal(selectDriverAssignmentQr(data, expected, 'another-driver'), null);
  assert.deepEqual({data, expected}, before);
});

test('Driver QR frontend rejects source, request, dispatch, trip, truck, Driver and SKU binding mismatches', () => {
  const {data, expected, driver} = fixture();
  for (const key of ['requestId', 'dispatchId', 'tripId', 'truckId', 'sourceStockpileId', 'sourceCrusherId', 'skuId', 'assignedDriverUserId']) {
    const changed = structuredClone(data); changed.binding[key] = 'mismatched-' + key;
    assert.equal(selectDriverAssignmentQr(changed, expected, driver.id), null, key);
  }
  for (const change of [{truckId: 'another-truck'}, {assignedDriverUserId: 'another-driver'}, {requestId: 'another-request'}, {stockpileId: 'another-source'}, {crusherId: 'another-crusher'}, {skuId: 'another-sku'}, {status: 'waiting_truck'}]) {
    assert.equal(selectDriverAssignmentQr(data, {...expected, ...change}, driver.id), null, JSON.stringify(change));
  }
  for (const change of [{source: 'LEGACY'}, {scanRecorded: true}, {authorizationGranted: true}, {qrReferenceOnly: false}]) assert.equal(selectDriverAssignmentQr({...data, ...change}, expected, driver.id), null);
});

test('Driver QR frontend rejects malformed, augmented or authorization QR data and incomplete allocation', () => {
  const {data, expected, driver} = fixture();
  for (const value of ['not-json', JSON.stringify({...JSON.parse(data.qr.value), token: 'synthetic-untrusted-field'}), JSON.stringify({...JSON.parse(data.qr.value), truckId: 'wrong-truck'})]) {
    const changed = structuredClone(data); changed.qr.value = value; changed.trip.qr.value = value;
    assert.equal(selectDriverAssignmentQr(changed, expected, driver.id), null);
  }
  for (const flags of [{isAuthorization: true}, {physicalScan: true}]) {
    const changed = structuredClone(data); Object.assign(changed.qr, flags); Object.assign(changed.trip.qr, flags);
    assert.equal(selectDriverAssignmentQr(changed, expected, driver.id), null);
  }
  for (const change of [{status: 'waiting_truck'}, {truckId: null}, {assignedDriverUserId: null}, {assignedDriver: null}]) {
    const changed = structuredClone(data); Object.assign(changed.trip, change);
    assert.equal(selectDriverAssignmentQr(changed, expected, driver.id), null);
  }
});

test('terminal QR remains an archive reference and every assignment field invalidates the modal identity', () => {
  const {data, expected, driver} = fixture();
  for (const status of ['returned', 'completed', 'cancelled']) {
    const changed = structuredClone(data); changed.trip.status = status; changed.historical = false; changed.qr.historical = false; changed.canOpenTask = true;
    const selected = selectDriverAssignmentQr(changed, expected, driver.id);
    assert.equal(selected.historical,true);assert.equal(Object.hasOwn(selected,'canOpenTask'),false);
    assert.equal(driverScanStage(selected),null);assert.equal(buildDriverScanIntent(selected,1,'archive-intent'),null);
  }
  const identity = driverAssignmentIdentity(expected, driver.id);
  for (const key of ['requestId', 'dispatchId', 'id', 'truckId', 'assignedDriverUserId', 'stockpileId', 'crusherId', 'skuId']) assert.notEqual(driverAssignmentIdentity({...expected, [key]: 'changed-' + key}, driver.id), identity, key);
  assert.notEqual(driverAssignmentIdentity(expected, 'changed-driver'), identity);
});

test('each explicit scan freezes its server-authorized stage and retries never turn Scan1 into Scan2',()=>{
 const {state,options,expected,driver,data}=fixture(),before=structuredClone(state);
 const selected=selectDriverAssignmentQr(data,expected,driver.id),intent=buildDriverScanIntent(selected,1,'first-explicit-intent');
 assert.deepEqual(state,before,'Selecting/displaying QR and building an intent do not record a scan');
 assert.equal(intent.expectedStage,1);assert.equal(intent.tripId,expected.id);assert.equal(intent.qrValue,data.qr.value);assert.equal(Object.hasOwn(intent,'confirmations'),false);
 const detached=selectDriverAssignmentQr(structuredClone(data),expected,driver.id),copy=buildDriverScanIntent(detached,1,'detached-intent');detached.binding.truckId='changed-local-object';assert.equal(copy.binding.truckId,expected.truckId,'Intent retains its own canonical binding snapshot');
 applyIntegratedAction(state,'trip.driver_scan',intent,driver,options);
 const ready=integratedView(state,driver,options).trips.find(x=>x.id===expected.id),readyData=driverAssignmentQr(state,driver,{tripId:expected.id,drivers:options.drivers}),readySelected=selectDriverAssignmentQr(readyData,ready,driver.id);
 assert.equal(ready.status,'ready_to_load');assert.equal(driverScanStage(readySelected),2);assert.equal(buildDriverScanIntent(readySelected,1,'stale-first-stage'),null);
 const replay=applyIntegratedAction(state,'trip.driver_scan',intent,driver,options);assert.equal(replay.replayed,true);assert.equal(state.trips.find(x=>x.id===expected.id).status,'ready_to_load');assert.equal(state.inventoryLedger.length,0);assert.equal(state.erpOutbox.length,0);
 const second=buildDriverScanIntent(readySelected,2,'second-explicit-intent');assert.equal(second.expectedStage,2);assert.deepEqual(second.confirmations,{materialReceived:true,truckReturned:true});assert.equal(intent.expectedStage,1,'A confirmed stage update never mutates the earlier retry intent');
 applyIntegratedAction(state,'trip.driver_scan',second,driver,options);
 const finished=integratedView(state,driver,options).trips.find(x=>x.id===expected.id),done=selectDriverAssignmentQr(driverAssignmentQr(state,driver,{tripId:expected.id,drivers:options.drivers}),finished,driver.id);
 assert.equal(finished.status,'returned');assert.equal(finished.displayStatus,'completed');assert.equal(done.historical,true);assert.equal(driverScanStage(done),null);assert.equal(buildDriverScanIntent(done,2,'third-attempt'),null);
});

test('a QR or canonical status alone cannot grant scanning without a matching server phase and eligibility',()=>{
 const {data,expected,driver}=fixture(),selected=selectDriverAssignmentQr(data,expected,driver.id);
 for(const driverScan of [null,{}, {...selected.driverScan,canScan:false},{...selected.driverScan,nextStage:2},{...selected.driverScan,phase:'READY_TO_LOAD'},{...selected.driverScan,nextStage:99}]){
  const changed={...selected,trip:{...selected.trip,status:'ready_to_load'},driverScan};assert.equal(driverScanStage(changed),null);assert.equal(buildDriverScanIntent(changed,1,'not-authorized'),null);
 }
 for(const intentId of ['',undefined,'bad/intent','x'.repeat(101)])assert.equal(buildDriverScanIntent(selected,1,intentId),null);
});
