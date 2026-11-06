import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction, integratedView} from '../server/integrated-demo-domain.mjs';

const admin = {id: 'admin-test', role: 'admin'};
const stock1 = {id: 'stock-user-1', role: 'stock', crusherIds: ['crusher-1']};
const stock2 = {id: 'stock-user-2', role: 'stock', crusherIds: ['crusher-2']};
const jetty1 = {id: 'jetty-user-1', role: 'jetty', jettyIds: ['jetty-1']};
const jetty2 = {id: 'jetty-user-2', role: 'jetty', jettyIds: ['jetty-2']};
const driver1 = {id: 'driver-test-1', role: 'driver', active: true};
const driver2 = {id: 'driver-test-2', role: 'driver', active: true};
const options = {drivers: [driver1, driver2]};
const act = (s, action, p, u = admin, opts = options) => applyIntegratedAction(s, action, action === 'request.create' ? {destinationLocationId: 'stockpile-location-crusher-2', ...p} : p, u, opts);
const close = (a, b, tolerance = 0.00001) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const trip = (s, identifier) => s.trips.find(t => t.id === identifier);
const sourceOperator = t => t.crusherId === 'crusher-1' ? stock1 : stock2;
const assignedDriver = t => t.assignedDriverUserId === driver1.id ? driver1 : driver2;

function seed({twoTrucks = false} = {}) {
  const s = createSeed();
  s.trucks = s.trucks.slice(0, twoTrucks ? 2 : 1);
  s.trucks.forEach(t => {t.bedM3 = 30; t.payloadLimitT = 40;});
  return s;
}

function request(s, {mode = 'LAND', tonnes = 80, lines, assignments} = {}) {
  const payload = {transferMode: mode, destination: mode === 'LAND' ? 'Crusher 2 receiving' : 'Marunda by barge', lines: lines || [{skuId: 'split-12', quantity: tonnes, unit: 't'}], ...(mode === 'LAND' ? {destinationId: 'crusher-2'} : {jettyId: 'jetty-1', vesselId: 'vessel-1'})};
  const created = act(s, 'request.create', payload);
  const planned = act(s, 'request.plan', {requestId: created.entityId, ...(assignments ? {assignments} : {})});
  return {requestId: created.entityId, ...planned};
}

function loadAndDepart(s, identifier, {startFirst = false} = {}) {
  let t = trip(s, identifier);
  const driver = assignedDriver(t), operator = sourceOperator(t);
  if (startFirst) act(s, 'trip.start', {tripId: identifier}, driver);
  act(s, 'trip.qr', {tripId: identifier, externalEventId: `qr-${identifier}`});
  act(s, 'trip.tare', {tripId: identifier, weightT: 15, externalEventId: `tare-${identifier}`}, operator);
  if (!startFirst) act(s, 'trip.start', {tripId: identifier}, driver);
  assert.equal(trip(s, identifier).status, 'ready_to_load');
  act(s, 'trip.loading', {tripId: identifier}, operator);
  act(s, 'trip.gross', {tripId: identifier, weightT: 15 + t.tonnageT, externalEventId: `gross-${identifier}`}, operator);
  act(s, 'trip.depart', {tripId: identifier, externalEventId: `depart-${identifier}`}, operator);
}

function receiveAndReturn(s, identifier) {
  const t = trip(s, identifier), receiver = t.transferMode === 'LAND' ? stock2 : jetty1;
  act(s, 'trip.arrive', {tripId: identifier}, receiver);
  act(s, 'trip.receive', {tripId: identifier, externalEventId: `receive-${identifier}`}, receiver);
  act(s, 'trip.return_start', {tripId: identifier}, assignedDriver(t));
  act(s, 'trip.return', {tripId: identifier, externalEventId: `return-${identifier}`}, sourceOperator(t));
}

test('LAND 80 tonnes, one 40 tonne truck: two serial trips conserve inventory and release all work', () => {
  const s = seed();
  const originalTotal = s.stockpiles.reduce((total, x) => total + x.onHandM3, 0);
  const source = s.stockpiles.find(x => x.crusherId === 'crusher-1' && x.skuId === 'split-12');
  const target = s.stockpiles.find(x => x.crusherId === 'crusher-2' && x.skuId === 'split-12');
  const sourceBefore = source.onHandM3, targetBefore = target.onHandM3;
  const result = request(s);
  assert.equal(result.tripIds.length, 2);
  assert.deepEqual(s.trips.map(t => t.tonnageT), [40, 40]);
  assert.ok(s.trips.every(t => t.truckId === s.trucks[0].id && t.assignedDriverUserId === driver1.id));
  close(s.stockpiles.find(x => x.id === source.id).reservedM3, 80 / 1.5);
  const [first, second] = result.tripIds;
  loadAndDepart(s, first);
  assert.throws(() => act(s, 'trip.start', {tripId: second}, driver1), e => e.code === 'TRUCK_OR_DRIVER_BUSY');
  act(s, 'trip.arrive', {tripId: first}, stock2);
  act(s, 'trip.receive', {tripId: first}, stock2);
  assert.equal(s.dispatches[0].status, 'in_progress');
  assert.equal(s.dispatches[0].deliveryStatus, 'partial');
  assert.throws(() => act(s, 'trip.start', {tripId: second}, driver1), e => e.code === 'TRUCK_OR_DRIVER_BUSY');
  act(s, 'trip.return_start', {tripId: first}, driver1);
  act(s, 'trip.return', {tripId: first}, stock1);
  loadAndDepart(s, second, {startFirst: true});
  act(s, 'trip.arrive', {tripId: second}, stock2);
  act(s, 'trip.receive', {tripId: second}, stock2);
  assert.equal(s.requests[0].deliveryStatus, 'received');
  assert.equal(s.requests[0].status, 'in_progress');
  assert.equal(s.dispatches[0].pendingTrips, 1);
  act(s, 'trip.return_start', {tripId: second}, driver1);
  act(s, 'trip.return', {tripId: second}, stock1);
  const finalSource = s.stockpiles.find(x => x.id === source.id), finalTarget = s.stockpiles.find(x => x.id === target.id);
  close(finalSource.onHandM3, sourceBefore - 80 / 1.5);
  close(finalTarget.onHandM3, targetBefore + 80 / 1.5);
  close(s.stockpiles.reduce((total, x) => total + x.onHandM3, 0), originalTotal);
  close(finalSource.reservedM3, 0);
  assert.equal(s.requests[0].deliveredT, 80);
  assert.equal(s.requests[0].remainingT, 0);
  assert.equal(s.requests[0].pendingTrips, 0);
  assert.equal(s.requests[0].status, 'completed');
  assert.equal(s.dispatches[0].status, 'completed');
  assert.equal(integratedView(s, admin, options).fleet[0].status, 'available');
  assert.equal(s.inventoryLedger.filter(e => e.type === 'transfer_departed').length, 2);
  assert.equal(s.inventoryLedger.filter(e => e.type === 'stock_transfer_received').length, 2);
  assert.equal(s.erpOutbox.length, 4);
  assert.ok(s.erpOutbox.every(e => e.source === 'INTEGRATED_DEMO' && e.status === 'awaiting_configuration'));
});

test('early QR and tare reconcile after start; late QR automatically recovers pending start', () => {
  for (const order of ['QR_TARE_START', 'START_TARE_QR', 'TARE_START_QR', 'START_QR_TARE']) {
    const s = seed(), result = request(s, {tonnes: 40}), identifier = result.tripIds[0];
    for (const step of order.split('_')) {
      if (step === 'START') act(s, 'trip.start', {tripId: identifier}, driver1);
      if (step === 'QR') act(s, 'trip.qr', {tripId: identifier});
      if (step === 'TARE') act(s, 'trip.tare', {tripId: identifier, weightT: 15}, stock1);
    }
    const t = trip(s, identifier);
    assert.equal(t.status, 'ready_to_load', order);
    assert.equal(t.tareT, 15);
    assert.equal(t.weighingEvents[0].status, 'ACCEPTED');
    assert.ok(!JSON.stringify(s).includes('FIELD_VERIFIED'));
  }
});

test('cannot depart without QR, tare and gross; reject excess and shortfall without partial mutation', () => {
  const s = seed(), {tripIds: [identifier]} = request(s, {tonnes: 40});
  act(s, 'trip.start', {tripId: identifier}, driver1);
  assert.throws(() => act(s, 'trip.depart', {tripId: identifier}, stock1), e => e.code === 'INVALID_TRANSITION');
  assert.throws(() => act(s, 'trip.loading', {tripId: identifier}, stock1), e => e.code === 'INVALID_TRANSITION');
  act(s, 'trip.qr', {tripId: identifier});
  for (const value of [undefined, null, '', false, 0, -1]) assert.throws(() => act(s, 'trip.tare', {tripId: identifier, weightT: value}, stock1));
  act(s, 'trip.tare', {tripId: identifier, weightT: 15}, stock1);
  act(s, 'trip.loading', {tripId: identifier}, stock1);
  const snapshot = structuredClone(s);
  for (const gross of [54, 56, 15]) {
    assert.throws(() => act(s, 'trip.gross', {tripId: identifier, weightT: gross}, stock1), e => e.code === 'WEIGHT_RECONCILIATION');
    assert.deepEqual(s, snapshot);
  }
  assert.throws(() => act(s, 'trip.depart', {tripId: identifier}, stock1), e => e.code === 'INVALID_TRANSITION');
  assert.equal(s.inventoryLedger.length, 0);
  assert.equal(s.requests[0].deliveredT, 0);
});

test('event retry is idempotent and conflicting content rejected across entity/action/actor', () => {
  const s = seed(), {tripIds: [identifier]} = request(s, {tonnes: 40});
  loadAndDepart(s, identifier);
  const before = structuredClone(s);
  const replay = act(s, 'trip.depart', {tripId: identifier, externalEventId: `depart-${identifier}`}, stock1);
  assert.equal(replay.replayed, true);
  // Timestamp may update on an accepted retry, but no physical/accounting effect.
  assert.deepEqual(s.inventoryLedger, before.inventoryLedger);
  assert.deepEqual(s.erpOutbox, before.erpOutbox);
  assert.deepEqual(s.stockpiles, before.stockpiles);
  assert.throws(() => act(s, 'trip.depart', {tripId: identifier, truckId: s.trucks[0].id, externalEventId: `depart-${identifier}`}, stock1), e => e.code === 'EVENT_CONFLICT');
  assert.throws(() => act(s, 'trip.depart', {tripId: identifier, externalEventId: `depart-${identifier}`}, admin), e => e.code === 'EVENT_CONFLICT');
  receiveAndReturn(s, identifier);
  const ledgerCount = s.inventoryLedger.length, erpCount = s.erpOutbox.length;
  const receiveReplay = act(s, 'trip.receive', {tripId: identifier, externalEventId: `receive-${identifier}`}, stock2);
  assert.equal(receiveReplay.replayed, true);
  assert.equal(s.inventoryLedger.length, ledgerCount);
  assert.equal(s.erpOutbox.length, erpCount);
});

test('MARINE multi-SKU reserves vessel capacity and multiple trucks operate in parallel', () => {
  const s = seed({twoTrucks: true});
  s.vessels[0].payloadLimitT = 100;
  const result = request(s, {mode: 'MARINE', lines: [{skuId: 'split-12', quantity: 40, unit: 't'}, {skuId: 'split-23', quantity: 60, unit: 't'}]});
  assert.equal(result.tripIds.length, 3);
  assert.equal(s.vessels[0].reservedT, 100);
  const own1 = s.trips.filter(t => t.assignedDriverUserId === driver1.id), own2 = s.trips.filter(t => t.assignedDriverUserId === driver2.id);
  assert.ok(own1.length && own2.length);
  act(s, 'trip.start', {tripId: own1[0].id}, driver1);
  act(s, 'trip.start', {tripId: own2[0].id}, driver2);
  assert.equal(integratedView(s, admin, options).fleet.filter(t => t.status === 'busy').length, 2);
  const extra = act(s, 'request.create', {transferMode: 'MARINE', jettyId: 'jetty-1', vesselId: 'vessel-1', destination: 'Additional cargo', lines: [{skuId: 'split-12', quantity: 1, unit: 't'}]});
  const before = structuredClone(s);
  assert.throws(() => act(s, 'request.plan', {requestId: extra.entityId}), e => e.code === 'VESSEL_CAPACITY');
  assert.deepEqual(s, before);
  for (const original of result.tripIds.map(identifier => trip(s, identifier)).sort((a, b) => a.sequence - b.sequence)) {
    let t = trip(s, original.id);
    if (t.status === 'queued') act(s, 'trip.start', {tripId: t.id}, assignedDriver(t));
    act(s, 'trip.qr', {tripId: t.id});
    act(s, 'trip.tare', {tripId: t.id, weightT: 15}, sourceOperator(t));
    act(s, 'trip.loading', {tripId: t.id}, sourceOperator(t));
    act(s, 'trip.gross', {tripId: t.id, weightT: 15 + t.tonnageT}, sourceOperator(t));
    act(s, 'trip.depart', {tripId: t.id}, sourceOperator(t));
    receiveAndReturn(s, t.id);
  }
  assert.equal(s.vessels[0].loadedT, 100);
  assert.equal(s.vessels[0].reservedT, 0);
  assert.equal(s.requests.find(r => r.id === result.entityId).status, 'completed');
});

test('assigned driver, location scopes and destination/truck identity are enforced at every handoff', () => {
  const s = seed(), {tripIds: [identifier]} = request(s, {mode: 'MARINE', tonnes: 40});
  const t = trip(s, identifier), origin = sourceOperator(t), wrongOrigin = origin.id === stock1.id ? stock2 : stock1;
  assert.throws(() => act(s, 'trip.start', {tripId: identifier}, driver2), e => e.code === 'FORBIDDEN');
  assert.throws(() => act(s, 'trip.start', {tripId: identifier}, admin), e => e.code === 'FORBIDDEN');
  assert.throws(() => act(s, 'trip.qr', {tripId: identifier}, driver1), e => e.code === 'FORBIDDEN');
  assert.throws(() => act(s, 'trip.tare', {tripId: identifier, weightT: 15}, wrongOrigin), e => e.code === 'FORBIDDEN');
  assert.throws(() => act(s, 'trip.qr', {tripId: identifier, truckId: 'truck-999'}), e => e.code === 'DESTINATION_MISMATCH');
  loadAndDepart(s, identifier);
  assert.throws(() => act(s, 'trip.arrive', {tripId: identifier}, jetty2), e => e.code === 'FORBIDDEN');
  assert.throws(() => act(s, 'trip.receive', {tripId: identifier}, driver1), e => e.code === 'FORBIDDEN');
  assert.throws(() => act(s, 'trip.return', {tripId: identifier}, origin), e => e.code === 'INVALID_TRANSITION');
  act(s, 'trip.arrive', {tripId: identifier}, jetty1);
  act(s, 'trip.receive', {tripId: identifier}, jetty1);
  assert.throws(() => act(s, 'trip.return', {tripId: identifier}, driver1), e => e.code === 'FORBIDDEN');
  assert.throws(() => act(s, 'trip.return_start', {tripId: identifier}, driver2), e => e.code === 'FORBIDDEN');
  act(s, 'trip.return_start', {tripId: identifier}, driver1);
  assert.throws(() => act(s, 'trip.return', {tripId: identifier}, jetty1), e => e.code === 'FORBIDDEN');
});

test('assignment planner requires active drivers and preserves stable truck-driver binding across queued requests', () => {
  const s = seed();
  const created = act(s, 'request.create', {transferMode: 'LAND', destinationId: 'crusher-2', destination: 'Marunda', lines: [{skuId: 'split-12', quantity: 80, unit: 't'}]});
  assert.throws(() => act(s, 'request.plan', {requestId: created.entityId}, admin, {drivers: []}), e => e.code === 'NO_DRIVERS');
  act(s, 'request.plan', {requestId: created.entityId, assignments: [{truckId: s.trucks[0].id, driverUserId: driver1.id}]});
  const extra = act(s, 'request.create', {transferMode: 'LAND', destinationId: 'crusher-2', destination: 'Marunda', lines: [{skuId: 'split-23', quantity: 40, unit: 't'}]});
  assert.throws(() => act(s, 'request.plan', {requestId: extra.entityId, assignments: [{truckId: s.trucks[0].id, driverUserId: driver2.id}]}), e => e.code === 'ASSIGNMENT_CONFLICT');
  act(s, 'request.plan', {requestId: extra.entityId});
  assert.equal(s.trips.length, 3);
  assert.ok(s.trips.every(t => t.assignedDriverUserId === driver1.id));
  assert.throws(() => act(s, 'trip.start', {tripId: s.trips[2].id}, driver1), e => e.code === 'QUEUE_ORDER');
});

test('role views expose only their trips/allocations while all actors see truthful global fleet occupancy', () => {
  const s = seed({twoTrucks: true});
  const result = request(s, {mode: 'MARINE', tonnes: 80});
  const first = s.trips.find(t => t.assignedDriverUserId === driver1.id);
  act(s, 'trip.start', {tripId: first.id}, driver1);
  const otherDriver = integratedView(s, driver2, options);
  assert.ok(otherDriver.trips.every(t => t.assignedDriverUserId === driver2.id));
  assert.equal(otherDriver.fleet.find(t => t.id === first.truckId).status, 'busy');
  assert.equal(otherDriver.fleet.find(t => t.id === first.truckId).activeTripId, null);
  assert.ok(otherDriver.dispatches.every(d => d.tripIds.every(identifier => otherDriver.trips.some(t => t.id === identifier))));
  assert.equal(otherDriver.dispatches[0].tonnageT, 40);
  assert.equal(otherDriver.requests[0].lines[0].tonnageT, 40);
  assert.ok(otherDriver.stockpiles.every(stock => stock.onHandM3 === undefined && stock.reservedM3 === undefined));
  const unrelatedStock = first.crusherId === 'crusher-1' ? stock2 : stock1;
  const stockView = integratedView(s, unrelatedStock, options);
  assert.equal(stockView.trips.length, 0);
  assert.equal(stockView.dispatches.length, 0);
  assert.equal(stockView.fleet.find(t => t.id === first.truckId).status, 'busy');
  assert.equal(stockView.fleet.find(t => t.id === first.truckId).activeTripId, null);
  const own = integratedView(s, driver1, options);
  assert.ok(!own.trips[0].allowedActions.includes('trip.start'));
  assert.equal(own.trips[0].blockReason, 'QR_REQUIRED');
  assert.equal(result.tripIds.length, 2);
});

test('LAND destination must match SKU and cannot reserve from its own destination location', () => {
  const s = seed();
  assert.throws(() => act(s, 'request.create', {transferMode: 'LAND', destinationId: 'crusher-2', destination: 'Marunda', lines: [{skuId: 'split-12', quantity: 1, unit: 't', destinationStockpileId: 'stock-2-1'}]}), e => e.code === 'DESTINATION_STOCKPILE_REQUIRED');
  s.stockpiles.filter(x => x.crusherId === 'crusher-1').forEach(x => x.onHandM3 = 0);
  const created = act(s, 'request.create', {transferMode: 'LAND', destinationId: 'crusher-2', destination: 'Marunda', lines: [{skuId: 'split-12', quantity: 40, unit: 't'}]});
  const before = structuredClone(s);
  assert.throws(() => act(s, 'request.plan', {requestId: created.entityId}), e => e.code === 'INSUFFICIENT_STOCK');
  assert.deepEqual(s, before);
});

test('tight stock rounding never over-reserves or produces negative stock over repeated 40t loads', () => {
  const s = seed();
  const source = s.stockpiles.find(x => x.crusherId === 'crusher-1' && x.skuId === 'split-12');
  source.onHandM3 = 53.333333;
  const {tripIds} = request(s);
  assert.equal(tripIds.length, 2);
  assert.equal(s.stockpiles.find(x => x.id === source.id).reservedM3, 53.333333);
  assert.equal(s.trips.reduce((sum, t) => sum + t.tonnageT, 0), 80);
  for (const identifier of tripIds) {
    loadAndDepart(s, identifier);
    assert.ok(s.stockpiles.every(x => x.onHandM3 >= 0 && x.reservedM3 >= 0 && x.reservedM3 <= x.onHandM3));
    receiveAndReturn(s, identifier);
  }
  assert.equal(s.stockpiles.find(x => x.id === source.id).onHandM3, 0);
  assert.equal(s.requests[0].deliveredT, 80);
  assert.equal(s.requests[0].status, 'completed');
});

test('stock measurements remain scoped while unrelated vessel cargo is redacted', () => {
  const s = seed();
  s.measurements = [{id: 'measure-1', crusherId: 'crusher-1'}, {id: 'measure-2', crusherId: 'crusher-2'}];
  request(s, {mode: 'MARINE', tonnes: 40});
  assert.deepEqual(integratedView(s, stock1, options).measurements.map(m => m.id), ['measure-1']);
  assert.equal(integratedView(s, driver1, options).measurements.length, 0);
  assert.ok(integratedView(s, driver1, options).vessels.every(v => v.id === 'vessel-1'));
  assert.ok(integratedView(s, jetty1, options).vessels.every(v => v.jettyId === 'jetty-1'));
});

test('default plan uses other free trucks when an earlier truck has unfinished legacy work', () => {
  const s = seed({twoTrucks: true});
  s.trips.push({id: 'legacy-open-trip', status: 'loading', sequence: 1, truckId: s.trucks[0].id});
  const {tripIds} = request(s, {tonnes: 40});
  assert.equal(tripIds.length, 1);
  const planned = trip(s, tripIds[0]);
  assert.equal(planned.truckId, s.trucks[1].id);
  assert.equal(planned.assignedDriverUserId, driver1.id);
  assert.equal(s.trips.find(t => t.id === 'legacy-open-trip').status, 'loading');
  const view = integratedView(s, admin, options);
  assert.equal(view.fleet[0].status, 'busy');
  assert.equal(view.fleet[1].status, 'allocated');
});

test('legacy event retention cannot discard integrated event replay receipts during marine creation', () => {
  const s = seed(), {tripIds: [identifier]} = request(s, {tonnes: 40});
  loadAndDepart(s, identifier);
  const retainedId = `depart-${identifier}`;
  assert.ok(s.events.some(e => e.externalEventId === retainedId));
  // Exercise the legacy 1,500-row retention boundary with a mixed operation
  // document. Integrated events are durable replay receipts, not UI ring items.
  for (let n = 0; n < 1501; n++) s.events.push({id: `integrated-padding-${n}`, at: new Date().toISOString(), actorId: admin.id, type: 'synthetic.test', entityId: identifier, source: 'INTEGRATED_DEMO', synthetic: true});
  for (let n = 0; n < 1800; n++) s.events.push({id: `legacy-padding-${n}`, at: new Date().toISOString(), actorId: admin.id, type: 'legacy.test', entityId: 'legacy-only'});
  const ledgerBefore = structuredClone(s.inventoryLedger), outboxBefore = structuredClone(s.erpOutbox);
  act(s, 'request.create', {transferMode: 'MARINE', jettyId: 'jetty-1', vesselId: 'vessel-1', destination: 'Retention test', lines: [{skuId: 'split-12', quantity: 1, unit: 't'}]});
  assert.ok(s.events.some(e => e.externalEventId === retainedId), 'integrated replay receipt survives legacy retention');
  assert.equal(s.events.filter(e => e.id.startsWith('integrated-padding-')).length, 1501);
  assert.ok(s.events.filter(e => e.source !== 'INTEGRATED_DEMO').length <= 1500, 'legacy display ring remains bounded');
  const replay = act(s, 'trip.depart', {tripId: identifier, externalEventId: retainedId}, stock1);
  assert.equal(replay.replayed, true);
  assert.deepEqual(s.inventoryLedger, ledgerBefore);
  assert.deepEqual(s.erpOutbox, outboxBefore);
});
