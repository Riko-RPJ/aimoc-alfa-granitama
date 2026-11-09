import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction} from '../server/integrated-demo-domain.mjs';
import {requestDetail} from '../server/request-detail.mjs';

const admin = {id: 'detail-admin', role: 'admin'};
const stock1 = {id: 'detail-stock-1', role: 'stock', crusherIds: ['crusher-1']};
const jetty1 = {id: 'detail-jetty-1', role: 'jetty', jettyIds: ['jetty-1']};
const driver1 = {id: 'detail-driver-1', role: 'driver', username: 'detail.driver1', displayName: 'Driver Detail 1', active: true, password_hash: 'PRIVATE_HASH_MUST_NOT_LEAK', token: 'PRIVATE_TOKEN_MUST_NOT_LEAK'};
const driver2 = {id: 'detail-driver-2', role: 'driver', username: 'detail.driver2', displayName: 'Driver Detail 2', active: true};
const drivers = [driver1, driver2];
const fingerprint = state => createHash('sha256').update(JSON.stringify(state)).digest('hex');

function fixture() {
  const state = createSeed();
  state.trucks = state.trucks.slice(0, 2).map(truck => ({...truck, bedM3: 30, payloadLimitT: 40, credential: 'PRIVATE_TRUCK_CREDENTIAL'}));
  // Use the real planner: request A owns repeated serial assignments; request B
  // remains unassigned while the two available truck/Driver pairs are claimed.
  state.stockpiles.find(stock => stock.crusherId === 'crusher-1' && stock.skuId === 'split-12').onHandM3 = 26.666667;
  state.stockpiles.find(stock => stock.crusherId === 'crusher-2' && stock.skuId === 'split-12').onHandM3 = 53.333333;
  const act = (action, payload, actor = admin) => applyIntegratedAction(state, action, payload, actor, {drivers});
  const create = (skuId, quantity, jettyId, vesselId) => act('request.create', {transferMode: 'MARINE', destinationLocationId: 'stockpile-location-crusher-2', destination: 'Not trusted', jettyId, vesselId, lines: [{skuId, quantity, unit: 't'}]}).requestId;
  const requestA = create('split-12', 120, 'jetty-1', 'vessel-1');
  const planA = act('request.plan', {requestId: requestA});
  const requestB = create('split-23', 60, 'jetty-2', 'vessel-3');
  const planB = act('request.plan', {requestId: requestB});
  assert.ok(state.trips.filter(trip=>trip.requestId===requestB).every(trip=>trip.status==='waiting_truck'&&trip.truckId===null));
  state.requests.find(request => request.id === requestA).pricing = {secret: 'PRIVATE_PRICE'};
  state.requests.find(request => request.id === requestA).erpCredentials = 'PRIVATE_ERP_CREDENTIAL';
  state.trips.find(trip => trip.id === planA.tripIds[0]).authToken = 'PRIVATE_TRIP_TOKEN';
  state.erpOutbox.push({id: 'private-erp-test', type: 'private-test', payload: {credentials: 'PRIVATE_ERP_PAYLOAD'}});
  return {state, act, requestA, requestB, planA, planB};
}

test('selected request detail never mixes another request and shares one QR per Driver dispatch', () => {
  const {state, requestA, requestB, planA, planB} = fixture();
  const detail = requestDetail(state, admin, {requestId: requestA, drivers});
  assert.equal(detail.source, 'INTEGRATED_DEMO');
  assert.equal(detail.request.id, requestA);
  assert.equal(detail.dispatches.length, 1);
  assert.equal(detail.trips.length, 3);
  assert.equal(detail.truckAssignments.length, 2);
  assert.equal(detail.waitingLoads.length, 0);
  assert.equal(detail.summary.plannedT, 120);
  const twice = detail.truckAssignments.find(group => group.trips.length === 2);
  assert.ok(twice);
  assert.equal(twice.assignedDriver.id, driver1.id);
  assert.equal(twice.summary.plannedT, 80);
  assert.equal(twice.trips[0].qr.value, twice.trips[1].qr.value);
  for (const trip of detail.trips) {
    assert.deepEqual(JSON.parse(trip.qr.value), {v: 1, type: 'AIMOC_DRIVER_DISPATCH_REFERENCE', dispatchId: planA.dispatchIds[0], truckId: trip.truckId, assignedDriverUserId:trip.assignedDriverUserId});
    assert.equal(trip.qr.isAuthorization, false);
    assert.equal(trip.qr.physicalScan, false);
    assert.equal(trip.qr.historical, false);
    assert.equal('assignmentId' in trip, false, 'no synthetic assignment entity is manufactured');
  }
  const json = JSON.stringify(detail);
  assert.ok(!json.includes(requestB));
  for (const id of [...planB.tripIds, ...planB.dispatchIds]) assert.ok(!json.includes(id));
  for (const secret of ['PRIVATE_HASH', 'PRIVATE_TOKEN', 'PRIVATE_TRUCK', 'PRIVATE_PRICE', 'PRIVATE_ERP', 'PRIVATE_TRIP']) assert.ok(!json.includes(secret));
  assert.equal('erpOutbox' in detail, false);
});

test('unassigned, waiting and invalid truck/driver rows remain waiting without QR or invented assignment', () => {
  const {state, requestA, planA} = fixture();
  const sample = state.trips.find(trip => trip.requestId === requestA);
  const pending = [
    {...sample, id: 'waiting-null', code: 'WAIT-1', status: 'waiting_truck', truckId: null, assignedDriverUserId: null, tonnageT: 20, volumeM3: 13.333333},
    {...sample, id: 'waiting-driver', code: 'WAIT-2', status: 'queued', truckId: state.trucks[0].id, assignedDriverUserId: null, tonnageT: 10, volumeM3: 6.666667},
    {...sample, id: 'waiting-unknown', code: 'WAIT-3', status: 'queued', truckId: 'truck-not-in-master', tonnageT: 5, volumeM3: 3.333333},
    {...sample, id: 'waiting-marked', code: 'WAIT-4', status: 'waiting_truck', truckId: state.trucks[0].id, assignedDriverUserId: driver1.id, tonnageT: 5, volumeM3: 3.333333},
  ];
  state.trips.push(...pending);
  state.dispatches.find(dispatch => dispatch.id === planA.dispatchIds[0]).tripIds.push(...pending.map(trip => trip.id));
  const before = fingerprint(state);
  const detail = requestDetail(state, admin, {requestId: requestA, drivers});
  assert.equal(detail.summary.waitingTrips, 4);
  assert.equal(detail.summary.assignedTrips, 3);
  assert.equal(detail.summary.plannedT, 160);
  assert.equal(detail.truckAssignments.length, 2);
  assert.ok(detail.waitingLoads.every(trip => trip.qr === null && trip.waitingReason));
  assert.equal(detail.waitingLoads.find(trip => trip.id === 'waiting-null').truckId, null);
  assert.equal(detail.waitingLoads.find(trip => trip.id === 'waiting-driver').waitingReason, 'DRIVER_NOT_ASSIGNED');
  assert.equal(detail.waitingLoads.find(trip => trip.id === 'waiting-unknown').waitingReason, 'TRUCK_NOT_ASSIGNED');
  assert.equal(fingerprint(state), before);
});

test('Admin, Stock, Jetty and Driver quantities and driver identities follow the existing role scope', () => {
  const {state, requestA} = fixture();
  for (const [actor, tonnes, trips] of [[admin, 120, 3], [stock1, 40, 1], [jetty1, 120, 3], [driver1, 80, 2]]) {
    const detail = requestDetail(state, actor, {requestId: requestA, drivers});
    assert.equal(detail.summary.plannedT, tonnes);
    assert.equal(detail.trips.length, trips);
    assert.equal(detail.request.lines[0].tonnageT, tonnes);
    assert.equal(detail.summary.remainingT, tonnes);
    assert.equal(detail.scoped, actor.role !== 'admin');
    if (actor.role === 'driver') assert.ok(detail.trips.every(trip => trip.assignedDriverUserId === actor.id));
    if (actor.role === 'stock') assert.ok(detail.trips.every(trip => trip.sourceCrusherCode === 'CR-01'));
    assert.equal(detail.dispatches[0].summary.plannedT, tonnes);
  }
  for (const actor of [{id: 'other-driver', role: 'driver'}, {id: 'other-jetty', role: 'jetty', jettyIds: ['jetty-2']}, {id: 'other-stock', role: 'stock', crusherIds: []}]) assert.throws(() => requestDetail(state, actor, {requestId: requestA, drivers}), error => error.status === 404);
  assert.throws(() => requestDetail(state, admin, {requestId: 'missing-request', drivers}), error => error.status === 404);
  for (const malformed of [undefined, '', '../request', 'id with spaces', 'x'.repeat(101)]) assert.throws(() => requestDetail(state, admin, {requestId: malformed, drivers}), error => error.status === 400);
});

test('completed trip QR is historical reference only and projection never creates scans, stock movements or authorization', () => {
  const {state, act, requestA, planA} = fixture();
  const tripId = planA.tripIds[0], original = state.trips.find(trip => trip.id === tripId);
  act('trip.qr', {tripId});
  act('trip.tare', {tripId, weightT: 15});
  act('trip.start', {tripId}, driver1);
  act('trip.loading', {tripId});
  act('trip.gross', {tripId, weightT: 15 + original.tonnageT});
  for (const action of ['depart', 'arrive', 'receive']) act(`trip.${action}`, {tripId});
  act('trip.return_start', {tripId}, driver1);
  act('trip.return', {tripId});
  const before = structuredClone(state), checksum = fingerprint(state);
  const detail = requestDetail(state, admin, {requestId: requestA, drivers});
  const trip = detail.trips.find(trip => trip.id === tripId);
  assert.equal(trip.historical, true);
  assert.equal(trip.qr.historical, true);
  assert.equal(trip.qr.isAuthorization, false);
  assert.equal(trip.qr.physicalScan, false);
  assert.equal(detail.summary.completedTrips, 1);
  assert.equal(detail.summary.receivedTrips, 1);
  assert.equal(detail.summary.deliveredT, 40);
  assert.equal(detail.summary.remainingT, 80);
  assert.deepEqual(state, before);
  assert.equal(fingerprint(state), checksum);
});

test('all role projections are fingerprint-preserving and optional assignment IDs are only copied from canonical rows', () => {
  const {state, requestA, planA} = fixture();
  const original = state.trips.find(trip => trip.id === planA.tripIds[0]);
  original.assignmentId = 'assignment-already-canonical';
  const before = structuredClone(state), checksum = fingerprint(state);
  for (const actor of [admin, stock1, jetty1, driver1]) {
    const detail = requestDetail(state, actor, {requestId: requestA, drivers});
    assert.ok(detail.trips.every(trip => !('allowedActions' in trip) && !('authToken' in trip)));
    const assigned = detail.trips.find(trip => trip.id === original.id);
    if (assigned) {assert.equal(assigned.assignmentId, original.assignmentId); assert.equal('assignmentId' in JSON.parse(assigned.qr.value), false);}
    assert.equal(fingerprint(state), checksum);
  }
  assert.deepEqual(state, before);
});

test('invalid cross-request dispatch reference cannot expose another dispatch or produce QR', () => {
  const {state, requestA, planA, planB} = fixture();
  state.trips.find(trip => trip.id === planA.tripIds[0]).dispatchId = planB.dispatchIds[0];
  const detail = requestDetail(state, admin, {requestId: requestA, drivers});
  const invalid = detail.trips.find(trip => trip.id === planA.tripIds[0]);
  assert.equal(invalid.dispatchId, null);
  assert.equal(invalid.qr, null);
  assert.equal(invalid.waitingReason, 'DISPATCH_REFERENCE_INVALID');
  assert.ok(!JSON.stringify(detail).includes(planB.dispatchIds[0]));
});

test('actual dispatch publishes one Driver dispatch QR while another dispatch waits for final return', () => {
  const state = createSeed(), catalog = [driver1];
  state.trucks = state.trucks.slice(0, 1).map(truck => ({...truck, bedM3: 30, payloadLimitT: 40}));
  const act = (action, payload, actor = admin) => applyIntegratedAction(state, action, payload, actor, {drivers: catalog});
  const requestId = act('request.create', {transferMode: 'MARINE', destinationLocationId: 'stockpile-location-crusher-2', jettyId: 'jetty-1', vesselId: 'vessel-1', lines: [{skuId: 'split-12', quantity: 120, unit: 't'}]}).requestId;
  act('request.plan', {requestId});
  const waitingRequest=act('request.create',{transferMode:'MARINE',destinationLocationId:'stockpile-location-crusher-2',jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-23',quantity:80,unit:'t'}]}).requestId;
  act('request.plan',{requestId:waitingRequest});
  const snapshot = () => {
    const checksum = fingerprint(state), detail = requestDetail(state, admin, {requestId, drivers: catalog});
    assert.equal(fingerprint(state), checksum, 'the detail GET never schedules cargo');
    assert.equal(detail.summary.plannedT, 120);
    assert.equal(detail.truckAssignments.length, 1);
    assert.ok(detail.waitingLoads.every(trip => trip.status === 'waiting_truck' && trip.truckId === null && trip.assignedDriverUserId === null && trip.qr === null));
    return detail;
  };
  const initial = snapshot();
  assert.equal(initial.summary.assignedTrips, 3);
  assert.equal(initial.summary.waitingTrips, 0);
  assert.equal(new Set(initial.trips.map(trip=>trip.qr.value)).size,1);
  const initialWaiting=requestDetail(state,admin,{requestId:waitingRequest,drivers:catalog});
  assert.equal(initialWaiting.summary.assignedTrips,0);assert.equal(initialWaiting.waitingLoads[0].tonnageT,80);assert.equal(initialWaiting.waitingLoads[0].qr,null);
  const completedIds = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = snapshot(), current = state.trips.find(trip => trip.requestId === requestId && trip.status === 'queued');
    assert.ok(current);
    assert.equal(current.tonnageT, 40);
    assert.equal(current.assignedDriverUserId, driver1.id);
    const reference = before.trips.find(trip => trip.id === current.id).qr;
    assert.deepEqual(JSON.parse(reference.value), {v: 1, type: 'AIMOC_DRIVER_DISPATCH_REFERENCE', dispatchId: current.dispatchId, truckId: 'truck-1', assignedDriverUserId: driver1.id});
    const futureBefore=before.trips.filter(trip=>trip.status==='queued'&&trip.id!==current.id);
    const tripId = current.id;
    act('trip.qr', {tripId});
    act('trip.tare', {tripId, weightT: 15});
    act('trip.start', {tripId}, driver1);
    act('trip.loading', {tripId});
    act('trip.gross', {tripId, weightT: 55});
    for (const action of ['depart', 'arrive', 'receive']) act(`trip.${action}`, {tripId});
    // Receipt never releases the truck claim. The shared dispatch reference
    // cannot bypass the per-trip queue before the current task returns.
    let received = snapshot();
    assert.equal(received.trips.filter(trip => trip.status === 'queued').length, 2-cycle);
    for(const future of futureBefore){assert.equal(received.trips.find(trip=>trip.id===future.id).qr.value,future.qr.value);assert.throws(()=>act('trip.start',{tripId:future.id},driver1),error=>error.code==='TRUCK_OR_DRIVER_BUSY'||error.code==='QUEUE_ORDER');}
    assert.ok(requestDetail(state,admin,{requestId:waitingRequest,drivers:catalog}).waitingLoads.every(trip=>trip.qr===null));
    act('trip.return_start', {tripId}, driver1);
    assert.equal(snapshot().trips.filter(trip => trip.status === 'queued').length, 2-cycle);
    act('trip.return', {tripId});
    completedIds.push(tripId);
    const after = snapshot();
    assert.equal(after.summary.completedTrips, cycle + 1);
    assert.equal(after.summary.deliveredT, (cycle + 1) * 40);
    assert.ok(after.trips.filter(trip => completedIds.includes(trip.id)).every(trip => trip.qr.historical));
    if (futureBefore.length) {
      const next = after.trips.find(trip => trip.status === 'queued');
      assert.ok(futureBefore.some(future=>future.id===next.id),'the next assignment is the same preassigned canonical trip');
      assert.notEqual(next.id, tripId);
      assert.ok(next.qr && !next.qr.historical);
    }
  }
  const final = snapshot();
  assert.equal(final.summary.completedTrips, 3);
  assert.equal(final.summary.waitingTrips, 0);
  assert.equal(final.summary.remainingT, 0);
  assert.equal(final.truckAssignments[0].trips.length, 3, 'one truck card groups its three historical trip references');
  assert.equal(state.requests.find(request => request.id === requestId).status, 'completed');
  const released=requestDetail(state,admin,{requestId:waitingRequest,drivers:catalog});
  assert.equal(released.summary.assignedTrips,2);assert.equal(released.summary.waitingTrips,0);
});
