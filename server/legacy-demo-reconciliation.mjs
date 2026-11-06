import {createHash, randomUUID} from 'node:crypto';
import {DomainError} from './domain.mjs';

const SOURCE = 'LEGACY_DEMO_RECONCILIATION';
const terminal = t => ['returned', 'cancelled'].includes(t.status);
const legacy = t => t.source === undefined || t.source === null || t.source === 'LEGACY';
const fail = (message, code = 'RECONCILIATION_HOLD') => {throw new DomainError(message, code, 409);};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const legacyOperationFingerprint = state => digest(state);
const units = (value, label, positive = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${label}: saldo/kuantitas tidak valid.`);
  const result = Math.round(value * 1e6);
  if (!Number.isSafeInteger(result) || positive && result <= 0 || Math.abs(value - result / 1e6) > 0.00000001) fail(`${label}: presisi tidak valid.`);
  return result;
};
const amount = n => n / 1e6;
const sum = (rows, key) => rows.reduce((total, row) => {
  const next = total + units(row[key], key, true);
  if (!Number.isSafeInteger(next)) fail('Total kuantitas melampaui presisi aman.');
  return next;
}, 0);
const find = (state, key, id) => state[key].find(row => row.id === id) || fail(`${key}: referensi tidak ditemukan.`);
const present = value => value !== undefined && value !== null && value !== false && value !== '' && !(Array.isArray(value) && value.length === 0);
const byId = values => [...values].sort((a, b) => a.id.localeCompare(b.id));

function parameters(state, options, actor) {
  if (actor?.role !== 'admin' || typeof actor.id !== 'string' || !actor.id) fail('Hanya Admin dapat merekonsiliasi demo.', 'FORBIDDEN');
  if (!options || !Array.isArray(options.tripIds) || !options.tripIds.length || options.tripIds.some(id => typeof id !== 'string' || !id) || new Set(options.tripIds).size !== options.tripIds.length) fail('Allowlist trip wajib unik dan eksplisit.');
  if (!Number.isSafeInteger(options.expectedTripCount) || options.expectedTripCount < 1 || options.expectedTripCount !== options.tripIds.length) fail('Jumlah allowlist tidak sesuai persetujuan.');
  if (typeof options.expectedRequestId !== 'string' || !options.expectedRequestId) fail('ID request yang disetujui wajib diisi.');
  if (typeof options.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedFingerprint)) fail('Fingerprint dokumen wajib diisi.');
  if (typeof options.batchId !== 'string' || !/^[\w-]{1,100}$/.test(options.batchId) || typeof options.reason !== 'string' || !options.reason.trim() || options.reason.length > 500) fail('Identitas dan alasan rekonsiliasi wajib diisi.');
  if (options.confirmedDemoOnly !== true || options.noHardware !== true || options.sidecarsAbsent !== true || typeof state.dataMode !== 'string' || !/\b(UAT|DEMO)\b/i.test(state.dataMode)) fail('Provenance UAT tanpa hardware/sidecar wajib dikonfirmasi.', 'DEMO_PROVENANCE_REQUIRED');
  for (const key of ['trips', 'requests', 'dispatches', 'stockpiles', 'vessels', 'inventoryLedger', 'erpOutbox', 'events']) if (!Array.isArray(state[key])) fail('Dokumen operasional tidak lengkap.');
  const scopeFingerprint = digest({batchId: options.batchId, tripIds: [...options.tripIds].sort(), expectedTripCount: options.expectedTripCount, expectedRequestId: options.expectedRequestId, expectedFingerprint: options.expectedFingerprint, reason: options.reason.trim(), actorId: actor.id, confirmedDemoOnly: true, noHardware: true, sidecarsAbsent: true});
  return {...options, reason: options.reason.trim(), scopeFingerprint};
}

function auditBalances(state) {
  const stock = new Map(state.stockpiles.map(row => [row.id, 0]));
  const vessel = new Map(state.vessels.map(row => [row.id, 0]));
  const preDeparture = new Set(['queued', 'start_pending', 'ready_to_load', 'loading', 'weighed']);
  const notReceived = new Set([...preDeparture, 'in_transit', 'arrived']);
  const known = new Set([...notReceived, 'unloaded', 'returning', 'returned', 'cancelled']);
  for (const trip of state.trips) {
    if (!known.has(trip.status)) fail(`Status ritase ${trip.id} tidak dikenal.`);
    if (terminal(trip)) continue;
    if (preDeparture.has(trip.status)) {
      if (!stock.has(trip.stockpileId)) fail('Referensi stockpile reservasi tidak ditemukan.');
      stock.set(trip.stockpileId, stock.get(trip.stockpileId) + units(trip.volumeM3, 'Volume ritase', true));
    }
    if (notReceived.has(trip.status) && trip.transferMode !== 'LAND') {
      if (!vessel.has(trip.vesselId)) fail('Referensi kapal reservasi tidak ditemukan.');
      vessel.set(trip.vesselId, vessel.get(trip.vesselId) + units(trip.tonnageT, 'Tonase ritase', true));
    }
  }
  const balances = [];
  for (const row of state.stockpiles) {
    const actual = units(row.reservedM3, 'Reservasi stockpile'), onHand = units(row.onHandM3, 'Stok stockpile');
    if (actual !== stock.get(row.id) || actual > onHand) fail(`Reservasi stockpile ${row.id} tidak cocok dengan seluruh ritase.`);
    balances.push({kind: 'stockpile', id: row.id, reserved: amount(actual), expected: amount(stock.get(row.id))});
  }
  for (const row of state.vessels) {
    const actual = units(row.reservedT, 'Reservasi kapal'), loaded = units(row.loadedT, 'Muatan kapal'), capacity = units(row.payloadLimitT, 'Kapasitas kapal', true);
    if (actual !== vessel.get(row.id) || loaded + actual > capacity) fail(`Reservasi/kapasitas kapal ${row.id} tidak cocok dengan seluruh ritase.`);
    balances.push({kind: 'vessel', id: row.id, reserved: amount(actual), expected: amount(vessel.get(row.id))});
  }
  return balances;
}

function prepare(state, rawOptions, actor) {
  const options = parameters(state, rawOptions, actor);
  const prior = state.requests.find(request => request.legacyReconciliation?.batchId === options.batchId)?.legacyReconciliation;
  if (prior) {
    if (prior.scopeFingerprint !== options.scopeFingerprint || options.tripIds.some(id => {const trip = state.trips.find(t => t.id === id); return trip?.status !== 'cancelled' || trip?.legacyReconciliation?.batchId !== options.batchId;})) fail('Batch rekonsiliasi digunakan dengan isi berbeda.', 'RECONCILIATION_CONFLICT');
    return {replayed: true, report: structuredClone(prior.report)};
  }
  if (state.trips.some(trip => trip.legacyReconciliation?.batchId === options.batchId)) fail('Metadata batch rekonsiliasi tidak konsisten.', 'RECONCILIATION_CONFLICT');
  if (legacyOperationFingerprint(state) !== options.expectedFingerprint) fail('Dokumen berubah setelah preflight.', 'FINGERPRINT_CONFLICT');
  const selected = options.tripIds.map(id => find(state, 'trips', id));
  const allLegacyOpen = state.trips.filter(trip => legacy(trip) && !terminal(trip));
  if (allLegacyOpen.length !== selected.length || allLegacyOpen.some(trip => !options.tripIds.includes(trip.id))) fail('Allowlist harus sama persis dengan seluruh legacy open yang disetujui.');
  const request = find(state, 'requests', options.expectedRequestId);
  if (!legacy(request) || selected.some(trip => !legacy(trip) || trip.requestId !== request.id || !['queued', 'loading'].includes(trip.status))) fail('Hanya satu request legacy belum berangkat yang dapat dibatalkan.');
  const requestTrips = state.trips.filter(trip => trip.requestId === request.id);
  if (requestTrips.length !== selected.length || requestTrips.some(trip => !options.tripIds.includes(trip.id)) || units(request.deliveredT || 0, 'Tonase terkirim') || units(request.deliveredM3 || 0, 'Volume terkirim')) fail('Request telah dieksekusi sebagian; perlu rekonsiliasi operator.');
  const dispatchIds = [...new Set(selected.map(trip => trip.dispatchId))];
  const dispatches = dispatchIds.map(id => find(state, 'dispatches', id));
  if (!dispatches.length || dispatches.some(dispatch => !legacy(dispatch) || dispatch.requestId !== request.id || units(dispatch.deliveredT || 0, 'Tonase dispatch terkirim') || units(dispatch.deliveredM3 || 0, 'Volume dispatch terkirim')) || state.dispatches.some(dispatch => dispatch.requestId === request.id && !dispatchIds.includes(dispatch.id))) fail('Dispatch/request tidak konsisten atau telah diterima sebagian.');
  for (const dispatch of dispatches) if (state.trips.some(trip => trip.dispatchId === dispatch.id && !options.tripIds.includes(trip.id))) fail('Dispatch memiliki ritase di luar allowlist.');
  const proofFields = /^(tare|gross|netT$|qr|weigh|departed|arrived|received|receipt|unloaded|returned|returnStarted)/i;
  for (const trip of selected) {
    units(trip.volumeM3, 'Volume ritase', true); units(trip.tonnageT, 'Tonase ritase', true);
    if (Object.entries(trip).some(([key, value]) => proofFields.test(key) && present(value)) || present(trip.quantitySource)) fail(`Ritase ${trip.id} memiliki bukti timbang/pergerakan; wajib ditahan.`);
    if (state.inventoryLedger.some(entry => entry.referenceId === trip.id || entry.tripId === trip.id) || state.erpOutbox.some(entry => entry.entityId === trip.id || entry.payload?.tripId === trip.id || entry.payload?.tripCode === trip.code)) fail(`Ritase ${trip.id} memiliki ledger/outbox; tidak boleh dibatalkan otomatis.`);
    if (state.events.some(entry => entry.entityId === trip.id && /(?:qr|tare|gross|weigh|depart|arriv|unload|receiv|return)/i.test(entry.type || ''))) fail(`Ritase ${trip.id} memiliki event eksekusi; wajib ditahan.`);
    const stock = find(state, 'stockpiles', trip.stockpileId);
    if (stock.skuId !== trip.skuId || stock.crusherId !== trip.crusherId) fail('Identitas stockpile/SKU ritase tidak cocok.');
    if (trip.transferMode === 'LAND' || request.transferMode === 'LAND' || !trip.vesselId || !trip.jettyId || trip.vesselId !== request.vesselId || trip.jettyId !== request.jettyId || find(state, 'vessels', trip.vesselId).jettyId !== trip.jettyId) fail('Helper ini hanya untuk request MARINE legacy yang diperiksa.');
  }
  const beforeBalances = auditBalances(state);
  const stockReleases = byId([...new Set(selected.map(trip => trip.stockpileId))].map(id => ({id, volumeM3: amount(sum(selected.filter(trip => trip.stockpileId === id), 'volumeM3'))})));
  const vesselReleases = byId([...new Set(selected.map(trip => trip.vesselId))].map(id => ({id, tonnageT: amount(sum(selected.filter(trip => trip.vesselId === id), 'tonnageT'))})));
  for (const release of stockReleases) if (units(release.volumeM3, 'Pelepasan stok') > units(find(state, 'stockpiles', release.id).reservedM3, 'Reservasi stok')) fail('Pelepasan stok melebihi reservasi.');
  for (const release of vesselReleases) if (units(release.tonnageT, 'Pelepasan kapal') > units(find(state, 'vessels', release.id).reservedT, 'Reservasi kapal')) fail('Pelepasan kapal melebihi reservasi.');
  const report = {source: SOURCE, batchId: options.batchId, actorId: actor.id, reason: options.reason, expectedFingerprint: options.expectedFingerprint, scopeFingerprint: options.scopeFingerprint, requestId: request.id, dispatchIds, tripIds: [...options.tripIds], cancelledTrips: selected.length, priorStatuses: Object.fromEntries(['queued', 'loading'].map(status => [status, selected.filter(trip => trip.status === status).length])), releases: {stockpiles: stockReleases, vessels: vesselReleases}, beforeBalances, onHandChanged: false, vesselLoadedChanged: false, inventoryLedgerChanged: false, erpOutboxChanged: false, manufacturedEvidence: false, provenance: {publishedUat: true, noHardware: true, sidecarsAbsent: true}};
  return {options, selected, request, dispatches, report, replayed: false};
}

/** Read-only preflight. Unknown evidence, incomplete allowlists and drift hold. */
export function previewLegacyDemoCancellation(state, options, actor) {
  const plan = prepare(state, options, actor);
  return {...structuredClone(plan.report), replayed: plan.replayed};
}

/** Caller must lock the operation row and enforce the expected DB revision. */
export function applyLegacyDemoCancellation(state, options, actor) {
  const draft = structuredClone(state), plan = prepare(draft, options, actor);
  if (plan.replayed) return {...plan.report, replayed: true};
  const at = new Date().toISOString();
  const auditIds = [];
  for (const release of plan.report.releases.stockpiles) {
    const stock = find(draft, 'stockpiles', release.id);
    stock.reservedM3 = amount(units(stock.reservedM3, 'Reservasi stockpile') - units(release.volumeM3, 'Pelepasan stockpile'));
  }
  for (const release of plan.report.releases.vessels) {
    const vessel = find(draft, 'vessels', release.id);
    vessel.reservedT = amount(units(vessel.reservedT, 'Reservasi kapal') - units(release.tonnageT, 'Pelepasan kapal'));
  }
  const metadata = {batchId: plan.options.batchId, source: SOURCE, scopeFingerprint: plan.options.scopeFingerprint, expectedFingerprint: plan.options.expectedFingerprint, actorId: actor.id, at, reason: plan.options.reason, outcome: 'CANCELLED_BEFORE_DEPARTURE', noPhysicalMovementRecorded: true, demoOnly: true};
  const audit = (type, entityId, extra = {}) => {
    const id = `reconcile-${randomUUID()}`; auditIds.push(id);
    draft.events.push({id, at, actorId: actor.id, role: 'admin', type, entityId, source: SOURCE, batchId: plan.options.batchId, synthetic: true, reason: plan.options.reason, ...extra});
  };
  for (const trip of plan.selected) {
    const priorStatus = trip.status;
    trip.status = 'cancelled'; trip.cancelledAt = at; trip.cancelledBy = actor.id; trip.cancellationReason = plan.options.reason;
    trip.legacyReconciliation = {...metadata, priorStatus, reservationReleased: {stockpileId: trip.stockpileId, volumeM3: trip.volumeM3, vesselId: trip.vesselId, tonnageT: trip.tonnageT}};
    audit('legacy.demo.trip.cancelled_before_departure', trip.id, {priorStatus, reservationReleased: trip.legacyReconciliation.reservationReleased});
  }
  for (const dispatch of plan.dispatches) {
    dispatch.status = 'cancelled'; dispatch.cancelledAt = at; dispatch.cancelledBy = actor.id; dispatch.cancelledTrips = plan.selected.filter(trip => trip.dispatchId === dispatch.id).length; dispatch.pendingTrips = 0;
    dispatch.legacyReconciliation = {...metadata, priorStatus: find(state, 'dispatches', dispatch.id).status};
    audit('legacy.demo.dispatch.cancelled_before_departure', dispatch.id);
  }
  plan.request.status = 'cancelled'; plan.request.cancelledAt = at; plan.request.cancelledBy = actor.id; plan.request.cancelledTrips = plan.selected.length; plan.request.pendingTrips = 0;
  const report = {...plan.report, at, auditIds, afterBalances: auditBalances(draft)};
  plan.request.legacyReconciliation = {...metadata, priorStatus: find(state, 'requests', plan.request.id).status, report};
  audit('legacy.demo.request.cancelled_before_departure', plan.request.id);
  // auditIds is copied into the saved report, including the final request audit.
  draft.updatedAt = at;
  Object.assign(state, draft);
  return {...structuredClone(report), replayed: false};
}
