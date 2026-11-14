import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction, integratedView} from '../server/integrated-demo-domain.mjs';
import {deriveStockpileLocations, stockpileLocationsForRead, ensureStockpileLocations, applyStockpileLocationAction, resolveStockpileDestination, guardReceivingCrusherMutation} from '../server/stockpile-locations.mjs';

const admin = {id: 'location-admin-test', role: 'admin'};
const driver = {id: 'location-driver-test', role: 'driver', active: true};
const options = {drivers: [driver]};
const second = 'stockpile-location-crusher-2';
const act = (state, action, payload, actor = admin) => applyIntegratedAction(state, action, payload, actor, options);
const master = (name = 'Independent destination', overrides = {}) => ({name, address: 'Synthetic address', transportModes: ['MARINE'], ...overrides});
const editable = location => ({id:location.id,name:location.name,address:location.address,transportModes:location.transportModes});
const payload = (mode = 'LAND', overrides = {}) => ({transferMode: mode, destinationLocationId: second, destination: 'Untrusted free text must be ignored', ...(mode === 'MARINE' ? {jettyId: 'jetty-1', vesselId: 'vessel-1'} : {}), lines: [{skuId: 'split-12', quantity: 10, unit: 't'}], ...overrides});

test('legacy document READ derives only existing active receiving areas without changing inventory or JSON', () => {
  const state = createSeed(); delete state.stockpileLocations;
  state.crushers[0].active = false;
  const before = JSON.stringify(state);
  const locations = stockpileLocationsForRead(state);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(locations, [{id: second, code: 'SPL-CR02', name: 'Stockpile Crusher 2', address: '', transportModes: ['LAND', 'MARINE'], receivingCrusherId: 'crusher-2', active: true}]);
  const view = integratedView(state, admin, options);
  assert.deepEqual(view.stockpileLocations, locations);
  assert.equal(JSON.stringify(state), before);
  ensureStockpileLocations(state);
  const persisted = JSON.stringify(state);
  ensureStockpileLocations(state);
  assert.equal(JSON.stringify(state), persisted);
  state.stockpileLocations = [];
  assert.deepEqual(stockpileLocationsForRead(state), [], 'an explicitly empty master is never reseeded');
});

test('default codes stay bounded and collision-safe for legal legacy crusher codes', () => {
  const state = createSeed(); delete state.stockpileLocations;
  state.crushers = [{id: 'crusher-1', code: 'C-1', name: 'First', active: true}, {id: 'crusher-2', code: 'C1', name: 'Second', active: true}, {id: 'crusher-3', code: 'X'.repeat(64), name: 'Third', active: true}];
  const locations = deriveStockpileLocations(state);
  assert.equal(new Set(locations.map(location => location.code)).size, 3);
  assert.ok(locations.every(location => location.code.length <= 64));
  const reversed = deriveStockpileLocations({...state, crushers: [...state.crushers].reverse()});
  for (const location of locations) assert.deepEqual(reversed.find(row => row.id === location.id), location);
  ensureStockpileLocations(state);
  assert.deepEqual(stockpileLocationsForRead(state), locations);
});

test('master CRUD is Admin-only, generated-code unique, guarded against managed fields, and atomic on failure', () => {
  const state = createSeed();
  const before = structuredClone(state);
  assert.throws(() => applyStockpileLocationAction(state, 'master.stockpileLocation.save', master(), {id: 'stock', role: 'stock'}), error => error.code === 'FORBIDDEN');
  for (const bad of [
    {code: 'INCOMPLETE'}, master('Test', {active: 'true'}), master('Test', {transportModes: ['RAIL']}), master('Test', {transportModes: ['LAND', 'LAND']}), master('Test', {receivingCrusherId: 42}), master('Test', {extra: 'unexpected'}), master('Test', {code: 'A\nB'}), master('Test', {name: ''}), master('Test', {code: 'X'.repeat(65)}),
  ]) {
    assert.throws(() => act(state, 'master.stockpileLocation.save', bad));
    assert.deepEqual(state, before);
  }
  const saved = act(state, 'master.stockpileLocation.save', master());
  assert.ok(state.stockpileLocations.some(location => location.id === saved.locationId));
  const secondSaved=act(state, 'master.stockpileLocation.save', master('Another'));
  assert.notEqual(secondSaved.locationCode.toLowerCase(),saved.locationCode.toLowerCase());
  const afterCreate = structuredClone(state);
  assert.throws(() => act(state, 'master.stockpileLocation.save', master('Override', {code: saved.locationCode})), error => error.code === 'STOCKPILE_LOCATION_MANAGED_FIELD');
  assert.deepEqual(state,afterCreate);
  act(state,'master.stockpileLocation.delete',{id:secondSaved.locationId});
  act(state, 'master.stockpileLocation.delete', {id: saved.locationId});
  assert.ok(!state.stockpileLocations.some(location => location.id === saved.locationId));
});

test('new LAND automatically gets dedicated logical receiving inventory; legacy target activity and SKU guards remain', () => {
  const state=createSeed();
  const saved=act(state,'master.stockpileLocation.save',master('New destination',{transportModes:['LAND']}));
  const location=state.stockpileLocations.find(row=>row.id===saved.locationId),area=state.crushers.find(row=>row.id===location.receivingCrusherId);
  assert.equal(area.kind,'RECEIVING_AREA');assert.equal(area.production,false);assert.equal(area.sourceEligible,false);
  assert.ok(state.stockpiles.filter(stock=>stock.crusherId===area.id).every(stock=>stock.onHandM3===0&&stock.reservedM3===0));
  const resolved=resolveStockpileDestination(state,payload('LAND',{destinationLocationId:location.id,destinationId:undefined}));assert.equal(resolved.destinationId,area.id);
  state.crushers.find(row=>row.id==='crusher-2').active=false;
  assert.throws(()=>act(state,'request.create',payload()),error=>error.code==='RECEIVING_AREA_REQUIRED');
  state.crushers.find(row=>row.id==='crusher-2').active=true;
  state.stockpiles.find(stock=>stock.crusherId==='crusher-2'&&stock.skuId==='split-12').active=false;
  assert.throws(()=>act(state,'request.create',payload()),error=>error.code==='DESTINATION_STOCKPILE_REQUIRED');
});

test('both new modes require an active allowed master ID; text cannot bypass validation or control snapshots', () => {
  for (const mode of ['LAND', 'MARINE']) {
    const state = createSeed();
    assert.throws(() => act(state, 'request.create', payload(mode, {destinationLocationId: undefined})), error => error.code === 'DESTINATION_LOCATION_REQUIRED');
    assert.throws(() => act(state, 'request.create', payload(mode, {destinationLocationId: 'missing'})), error => error.code === 'DESTINATION_LOCATION_NOT_FOUND');
    const created = act(state, 'request.create', payload(mode));
    const request = state.requests.find(row => row.id === created.entityId);
    assert.equal(request.destination, 'Stockpile Crusher 2');
    assert.equal(request.destinationLocationCode, 'SPL-CR02');
    assert.equal(request.destinationLocationId, second);
    assert.equal(request.destinationLocationSnapshot.name, request.destination);
    if (mode === 'LAND') assert.equal(request.destinationId, 'crusher-2');
    else {assert.equal(request.jettyId, 'jetty-1'); assert.equal(request.vesselId, 'vessel-1');}
  }
  const state = createSeed();
  const saved = act(state, 'master.stockpileLocation.save', master());
  assert.throws(() => act(state, 'request.create', payload('LAND', {destinationLocationId: saved.locationId})), error => error.code === 'DESTINATION_MODE_INVALID');
  assert.throws(()=>act(state,'master.stockpileLocation.save',master('Inactive',{id:saved.locationId,active:false})),error=>error.code==='STOCKPILE_LOCATION_MANAGED_FIELD');
  state.stockpileLocations.find(row=>row.id===saved.locationId).active=false;
  assert.throws(() => act(state, 'request.create', payload('MARINE', {destinationLocationId: saved.locationId})), error => error.code === 'INACTIVE_DESTINATION');
  assert.throws(() => act(state, 'request.create', payload('LAND', {destinationId: 'crusher-1'})), error => error.code === 'DESTINATION_MISMATCH');
});

test('planned request, dispatch, trip and ERP snapshots stay frozen through permissible master rename', () => {
  const state = createSeed();
  const created = act(state, 'request.create', payload('LAND'));
  const originalSnapshot = structuredClone(state.requests[0].destinationLocationSnapshot);
  const location = state.stockpileLocations.find(location => location.id === second);
  act(state, 'master.stockpileLocation.save', {...editable(location), name: 'Renamed receiving site', address: 'New address'});
  const planned = act(state, 'request.plan', {requestId: created.entityId});
  assert.deepEqual(state.requests[0].destinationLocationSnapshot, originalSnapshot);
  assert.deepEqual(state.dispatches[0].destinationLocationSnapshot, originalSnapshot);
  assert.deepEqual(state.trips[0].destinationLocationSnapshot, originalSnapshot);
  const tripId = planned.tripIds[0], net = state.trips[0].tonnageT;
  act(state, 'trip.qr', {tripId});
  act(state, 'trip.tare', {tripId, weightT: 15});
  act(state, 'trip.start', {tripId}, driver);
  act(state, 'trip.loading', {tripId});
  act(state, 'trip.gross', {tripId, weightT: 15 + net});
  act(state, 'trip.depart', {tripId});
  assert.deepEqual(state.erpOutbox[0].payload.destinationLocationSnapshot, originalSnapshot);
  for (const action of ['arrive', 'receive']) act(state, `trip.${action}`, {tripId});
  act(state, 'trip.return_start', {tripId}, driver);
  act(state, 'trip.return', {tripId});
  const current = state.stockpileLocations.find(location => location.id === second);
  assert.throws(()=>act(state,'master.stockpileLocation.save',{...editable(current),receivingCrusherId:'crusher-1'}),error=>error.code==='STOCKPILE_LOCATION_MANAGED_FIELD');
  assert.deepEqual(state.trips[0].destinationLocationSnapshot, originalSnapshot);
  assert.throws(() => act(state, 'master.stockpileLocation.delete', {id: second}), error => error.code === 'LOCATION_IN_USE');
});

test('open requested or queued work prevents receiving-area rebind, deactivation and mode removal', () => {
  for (const planned of [false, true]) {
    const state = createSeed(), created = act(state, 'request.create', payload());
    if (planned) act(state, 'request.plan', {requestId: created.entityId});
    const location = state.stockpileLocations.find(location => location.id === second), before = structuredClone(state);
    for (const change of [{active: false}, {receivingCrusherId: 'crusher-1'}, {transportModes: ['MARINE']}]) {
      assert.throws(() => act(state, 'master.stockpileLocation.save', {...editable(location), ...change}), error => error.code === (Object.hasOwn(change,'transportModes')?'OPEN_LOCATION_REFERENCE':'STOCKPILE_LOCATION_MANAGED_FIELD'));
      assert.deepEqual(state, before);
    }
    assert.throws(() => act(state, 'master.stockpileLocation.delete', {id: second}), error => error.code === 'LOCATION_IN_USE');
  }
});

test('legacy requested rows resolve only during authorized planning; existing MARINE text is left unmapped', () => {
  const state = createSeed(); delete state.stockpileLocations;
  const row = {id: 'existing-land', source: 'INTEGRATED_DEMO', transferMode: 'LAND', destinationId: 'crusher-2', destination: 'Old descriptive text', lines: [{skuId: 'split-12', quantity: 10, unit: 't', tonnageT: 10, volumeM3: 6.666667, densityTPerM3: 1.5}], status: 'requested', deliveredM3: 0, deliveredT: 0};
  state.requests.push(row);
  const before = JSON.stringify(state);
  integratedView(state, admin, options);
  assert.equal(JSON.stringify(state), before);
  const viewOnly = resolveStockpileDestination(state, row, {allowLegacy: true});
  assert.equal(viewOnly.destinationLocationId, second);
  assert.equal(JSON.stringify(state), before);
  act(state, 'request.plan', {requestId: row.id});
  assert.ok(Array.isArray(state.stockpileLocations));
  assert.equal(state.requests[0].destinationLocationId, second);
  assert.equal(state.trips[0].destinationCrusherId, 'crusher-2');
  const marine = resolveStockpileDestination(state, {transferMode: 'MARINE', destination: 'Original marine text'}, {allowLegacy: true});
  assert.equal(marine.destinationLocationId, null);
  assert.equal(marine.destination, 'Original marine text');
  assert.equal(marine.legacyDestinationUnmapped, true);
});

test('legacy LAND references protect mapping, and receiving crusher guards preserve configured destinations', () => {
  const state = createSeed();
  const unmigrated = structuredClone(state); delete unmigrated.stockpileLocations;
  assert.doesNotThrow(() => guardReceivingCrusherMutation(unmigrated, 'master.crusher.delete', {id: 'crusher-2'}), 'virtual READ defaults do not create persisted references');
  state.requests.push({id: 'legacy', transferMode: 'LAND', destinationId: 'crusher-2', status: 'requested'});
  const location = state.stockpileLocations.find(location => location.id === second);
  assert.throws(() => act(state, 'master.stockpileLocation.save', {...editable(location), receivingCrusherId: 'crusher-1'}), error => error.code === 'STOCKPILE_LOCATION_MANAGED_FIELD');
  assert.throws(() => guardReceivingCrusherMutation(state, 'master.crusher.delete', {id: 'crusher-2'}), error => error.code === 'RECEIVING_LOCATION_IN_USE');
  assert.throws(() => guardReceivingCrusherMutation(state, 'master.crusher.save', {id: 'crusher-2', active: false}), error => error.code === 'RECEIVING_LOCATION_IN_USE');
  assert.doesNotThrow(() => guardReceivingCrusherMutation(state, 'master.crusher.save', {id: 'crusher-2', name: 'Rename only'}));
});

test('legacy LAND mapping requires an explicit choice when several master locations share its receiving area', () => {
  const state = createSeed();
  const other={locationId:'legacy-second-mapped-destination'};
  state.stockpileLocations.push({id:other.locationId,code:'SPL-LEGACY-ALIAS',name:'Second mapped destination',address:'',transportModes:['LAND'],receivingCrusherId:'crusher-2',active:true});
  const row = {id: 'legacy-ambiguous', source: 'INTEGRATED_DEMO', transferMode: 'LAND', destinationId: 'crusher-2', destination: 'Historical free text', lines: [{skuId: 'split-12', quantity: 10, unit: 't', tonnageT: 10, volumeM3: 6.666667, densityTPerM3: 1.5}], status: 'requested', deliveredM3: 0, deliveredT: 0};
  state.requests.push(row);
  const before = structuredClone(state);
  assert.throws(() => act(state, 'request.plan', {requestId: row.id}), error => error.code === 'DESTINATION_LOCATION_AMBIGUOUS');
  assert.deepEqual(state, before);
  act(state, 'request.plan', {requestId: row.id, destinationLocationId: other.locationId});
  assert.equal(state.requests[0].destinationLocationId, other.locationId);
  assert.equal(state.trips[0].destinationLocationName, 'Second mapped destination');
});
