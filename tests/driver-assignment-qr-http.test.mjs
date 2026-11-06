import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {bootstrap} from '../scripts/setup.mjs';
import {hash} from '../server/auth.mjs';
import {createHandler} from '../server/handler.mjs';
import {applyIntegratedAction} from '../server/integrated-demo-domain.mjs';

test('authenticated Driver assignment QR is exact, scoped, read-only and never grants scan or start permission', async t => {
  const db = await createEmbeddedDatabase(); await bootstrap(db);
  let server;
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });
  for (const number of [1, 2]) await db.query("INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,'synthetic-unused-login-hash','driver')", [`qr-driver-${number}`, `qr-driver-${number}`, `Synthetic QR Driver ${number}`]);
  const users = (await db.query('SELECT * FROM aimoc_alfa_ops.users')).rows, actors = {};
  for (const user of users) {
    const session = user.username.padEnd(43, 'x');
    await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-qr-csrf',now()+interval '1 hour')", [hash(session), user.id]);
    actors[user.username] = {id: user.id, role: user.role, active: user.active, cookie: 'alfa_session=' + session};
  }
  const original = (await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
  const spareTruck = structuredClone(original.trucks[1]);
  const state = structuredClone(original);
  state.products.find(product => product.id === 'split-12').densityTPerM3 = 2;
  for (const pile of state.stockpiles.filter(pile => pile.skuId === 'split-12')) pile.onHandM3 = pile.crusherId === 'crusher-1' ? 1000 : 0;
  state.trucks = [{...state.trucks[0], bedM3: 30, payloadLimitT: 40}];
  const drivers = users.filter(user => user.role === 'driver').map(user => ({id: user.id, username: user.username, displayName: user.display_name, role: 'driver', active: true}));
  const act = (action, payload) => applyIntegratedAction(state, action, payload, actors.admin, {drivers});
  const makeRequest = quantity => act('request.create', {transferMode: 'MARINE', destinationLocationId: 'stockpile-location-crusher-2', jettyId: 'jetty-1', vesselId: 'vessel-1', lines: [{skuId: 'split-12', quantity, unit: 't'}]}).requestId;
  const requestId = makeRequest(120); act('request.plan', {requestId});
  const serial = state.trips.filter(trip => trip.requestId === requestId).sort((a, b) => a.sequence - b.sequence);
  assert.equal(serial.length, 3); assert.ok(serial.every(trip => trip.assignedDriverUserId === actors['qr-driver-1'].id));
  const waitingRequestId = makeRequest(20); act('request.plan', {requestId: waitingRequestId});
  const waiting = state.trips.find(trip => trip.requestId === waitingRequestId); assert.equal(waiting.status, 'waiting_truck');
  const store = async document => db.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb,revision=91 WHERE id=1', [JSON.stringify(document)]);
  await store(state);
  server = http.createServer(createHandler(db)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const call = async (pathname, username, method = 'GET', body = {}) => {
    const response = await fetch(origin + pathname, {method, headers: {...(actors[username] ? {Cookie: actors[username].cookie} : {}), ...(method !== 'GET' ? {Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': 'synthetic-qr-csrf'} : {})}, ...(method !== 'GET' ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, body: await response.json(), headers: response.headers};
  };
  const qr = (id, username, method, body) => call('/api/v1/demo/trips/' + id + '/assignment-qr', username, method, body);
  const fingerprint = async () => {
    const row = (await db.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
    const actions = (await db.query('SELECT * FROM aimoc_alfa_ops.actions ORDER BY actor_id,request_id')).rows;
    return createHash('sha256').update(JSON.stringify({row, actions})).digest('hex');
  };
  const assertUnchanged = async (before, reason) => assert.equal(await fingerprint(), before, reason);
  const code = response => response.body.error?.code || response.body.error;

  await t.test('GET matches the Admin QR while enforcing authentication, ownership, scope and method', async () => {
    const before = await fingerprint();
    assert.equal((await qr(serial[0].id)).status, 401);
    const own = await qr(serial[0].id, 'qr-driver-1');
    assert.equal(own.status, 200); assert.equal(own.body.revision, 91); assert.match(own.headers.get('cache-control'), /no-store/);
    assert.equal(own.body.source, 'INTEGRATED_DEMO'); assert.equal(own.body.trip.id, serial[0].id);
    assert.equal(own.body.request.id, requestId); assert.equal(own.body.dispatch.id, serial[0].dispatchId);
    assert.deepEqual(own.body.binding, {requestId, dispatchId: serial[0].dispatchId, tripId: serial[0].id, truckId: serial[0].truckId, sourceStockpileId: serial[0].stockpileId, sourceCrusherId: serial[0].crusherId, skuId: serial[0].skuId, assignedDriverUserId: actors['qr-driver-1'].id});
    assert.equal(own.body.qrReferenceOnly, true); assert.equal(own.body.scanRecorded, false); assert.equal(own.body.authorizationGranted, false);
    assert.equal(own.body.historical, false); assert.equal(own.body.canOpenTask, true);
    assert.equal(own.body.qr.isAuthorization, false); assert.equal(own.body.qr.physicalScan, false);
    const adminDetail = await call('/api/v1/demo/requests/' + requestId + '/detail', 'admin');
    assert.equal(adminDetail.status, 200);
    assert.equal(own.body.qr.value, adminDetail.body.trips.find(trip => trip.id === serial[0].id).qr.value);
    assert.equal((await qr(serial[0].id, 'admin')).body.qr.value, own.body.qr.value);
    assert.equal((await qr(serial[0].id, 'stock1')).status, 200); assert.equal((await qr(serial[0].id, 'jetty1')).status, 200);
    for (const username of ['qr-driver-2', 'stock2', 'jetty2']) assert.equal((await qr(serial[0].id, username)).status, 404, username);
    assert.equal((await qr('trip-missing', 'qr-driver-1')).status, 404);
    assert.equal((await qr('bad%2Fid', 'qr-driver-1')).status, 400);
    const post = await qr(serial[0].id, 'qr-driver-1', 'POST', {action: 'trip.qr', tripId: serial[0].id});
    assert.equal(post.status, 405); assert.equal(code(post), 'METHOD_NOT_ALLOWED');
    const future = await qr(serial[1].id, 'qr-driver-1'); assert.equal(future.status, 200);
    const start = await call('/api/v1/demo/actions', 'qr-driver-1', 'POST', {requestId: 'qr-future-start-' + randomUUID(), action: 'trip.start', payload: {tripId: serial[1].id}, expectedRevision: 91});
    assert.equal(start.status, 409); assert.equal(code(start), 'QUEUE_ORDER', 'Viewing a future QR must not unlock serial start');
    const scan = await call('/api/v1/demo/actions', 'qr-driver-1', 'POST', {requestId: 'qr-driver-scan-' + randomUUID(), action: 'trip.qr', payload: {tripId: serial[0].id}, expectedRevision: 91});
    assert.equal(scan.status, 403, 'Displaying a reference must not grant the Driver permission to record a QR scan');
    assert.doesNotMatch(JSON.stringify(own.body), /password_hash|csrf_token|csrfToken|erpOutbox|inventoryLedger|sessionToken/);
    await assertUnchanged(before, 'Every QR read, denied method and denied action leaves raw operation/revision/actions unchanged');
  });

  await t.test('invalid source and dispatch bindings never return a QR and do not repair canonical records', async () => {
    const mutations = [
      [404, document => { document.trips.find(trip => trip.id === serial[0].id).source = 'LEGACY_OR_UNTRUSTED'; }],
      [409, document => { document.trips.find(trip => trip.id === serial[0].id).dispatchId = 'dispatch-unrelated'; }],
      [409, document => { document.dispatches.find(dispatch => dispatch.id === serial[0].dispatchId).tripIds = []; }],
      [409, document => { document.trips.find(trip => trip.id === serial[0].id).stockpileId = 'stockpile-missing'; }],
      [409, document => { document.stockpiles.find(pile => pile.id === serial[0].stockpileId).skuId = 'sku-mismatch'; }]
    ];
    for (const [expectedStatus, mutate] of mutations) {
      const document = structuredClone(state); mutate(document); await store(document);
      const before = await fingerprint(), response = await qr(serial[0].id, 'qr-driver-1');
      assert.equal(response.status, expectedStatus); assert.equal(code(response), expectedStatus === 404 ? 'NOT_FOUND' : 'ASSIGNMENT_QR_BINDING_INVALID'); assert.equal(response.body.qr, undefined);
      await assertUnchanged(before, 'Invalid binding read must not normalize, allocate, scan or repair data');
    }
    const unassigned = structuredClone(state); Object.assign(unassigned.trips.find(trip => trip.id === serial[0].id), {status: 'waiting_truck', truckId: null});
    await store(unassigned); const before = await fingerprint(), response = await qr(serial[0].id, 'qr-driver-1');
    assert.equal(response.status, 409); assert.equal(code(response), 'ASSIGNMENT_QR_NOT_AVAILABLE'); assert.equal(response.body.qr, undefined);
    await assertUnchanged(before, 'An unassigned QR read must never allocate a truck');
  });

  await t.test('reassignment immediately removes old ownership and historical QR remains a non-operational reference', async () => {
    await store(state); const previous = await qr(serial[0].id, 'qr-driver-1'); assert.equal(previous.status, 200);
    const changed = structuredClone(state); changed.trucks.push(spareTruck);
    Object.assign(changed.trips.find(trip => trip.id === serial[0].id), {truckId: spareTruck.id, assignedDriverUserId: actors['qr-driver-2'].id});
    await store(changed); let before = await fingerprint();
    assert.equal((await qr(serial[0].id, 'qr-driver-1')).status, 404);
    const replacement = await qr(serial[0].id, 'qr-driver-2'); assert.equal(replacement.status, 200);
    assert.equal(replacement.body.binding.assignedDriverUserId, actors['qr-driver-2'].id); assert.equal(replacement.body.binding.truckId, spareTruck.id);
    assert.notEqual(replacement.body.qr.value, previous.body.qr.value);
    await assertUnchanged(before, 'Reading reassignment cannot change assignment state or evidence');
    for (const status of ['returned', 'cancelled']) {
      const archived = structuredClone(changed); archived.trips.find(trip => trip.id === serial[0].id).status = status; await store(archived); before = await fingerprint();
      const response = await qr(serial[0].id, 'qr-driver-2'); assert.equal(response.status, 200);
      assert.equal(response.body.historical, true); assert.equal(response.body.qr.historical, true); assert.equal(response.body.canOpenTask, false);
      assert.equal(response.body.scanRecorded, false); assert.equal(response.body.authorizationGranted, false);
      await assertUnchanged(before, 'Historical QR read must not resume or recreate a trip');
    }
    await db.query('UPDATE aimoc_alfa_ops.users SET active=false WHERE id=$1', [actors['qr-driver-2'].id]);
    assert.equal((await qr(serial[0].id, 'qr-driver-2')).status, 401, 'An inactive account cannot use a retained session');
  });
});
