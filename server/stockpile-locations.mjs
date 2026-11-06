import {randomUUID, createHash} from 'node:crypto';

const fail = (message, code = 'STOCKPILE_LOCATION_INVALID', status = 400) => {throw Object.assign(new Error(message), {name: 'DomainError', code, status});};
const terminal = value => ['completed', 'returned', 'cancelled', 'partially_cancelled'].includes(value.status);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const string = (value, label, max, allowEmpty = false) => {
  if (typeof value !== 'string' || value.length > max || !allowEmpty && (!value.trim() || /[\r\n\t]/.test(value)) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} tidak valid.`);
  return value.trim();
};

function validateShape(location, {allowMissingId = false} = {}) {
  if (!location || typeof location !== 'object' || Array.isArray(location)) fail('Lokasi harus berupa object.');
  const keys = ['id', 'code', 'name', 'address', 'transportModes', 'receivingCrusherId', 'active'];
  if (Object.keys(location).some(key => !keys.includes(key)) || keys.filter(key => key !== 'id').some(key => !Object.hasOwn(location, key))) fail('Field lokasi harus lengkap dan sesuai kontrak.');
  if ((!allowMissingId || location.id !== undefined) && !identifier(location.id)) fail('ID lokasi tidak valid.');
  if (!Array.isArray(location.transportModes) || !location.transportModes.length || location.transportModes.length > 2 || new Set(location.transportModes).size !== location.transportModes.length || location.transportModes.some(mode => !['LAND', 'MARINE'].includes(mode))) fail('Moda transport harus LAND dan/atau MARINE.');
  if (typeof location.active !== 'boolean') fail('Status aktif harus boolean.');
  if (location.receivingCrusherId !== null && !identifier(location.receivingCrusherId)) fail('Area penerimaan tidak valid.');
  return {...(location.id === undefined ? {} : {id: location.id}), code: string(location.code, 'Kode lokasi', 64), name: string(location.name, 'Nama lokasi', 160), address: string(location.address, 'Alamat lokasi', 500, true), transportModes: ['LAND', 'MARINE'].filter(mode => location.transportModes.includes(mode)), receivingCrusherId: location.receivingCrusherId, active: location.active};
}

/** Derive only real existing receiving areas; no inferred geographic mapping. */
export function deriveStockpileLocations(state) {
  const crushers = (state.crushers || []).filter(crusher => crusher.active === true);
  const baseCode = crusher => `SPL-${String(crusher.code || crusher.id).replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'AREA'}`;
  const used = new Set(), codes = new Map();
  for (const crusher of [...crushers].sort((a, b) => a.id.localeCompare(b.id))) {
    const base = baseCode(crusher), hash = createHash('sha256').update(crusher.id).digest('hex').toUpperCase();
    const collision = crushers.some(other => other.id !== crusher.id && baseCode(other).slice(0, 64) === base.slice(0, 64));
    let code = base.length > 64 || collision ? `${base.slice(0, 55)}-${hash.slice(0, 8)}` : base;
    for (let width = 12; used.has(code); width += 4) code = `${base.slice(0, 63 - width)}-${hash.slice(0, width)}`;
    used.add(code); codes.set(crusher.id, code);
  }
  return crushers.map(crusher => ({id: `stockpile-location-${crusher.id}`, code: codes.get(crusher.id), name: `Stockpile ${crusher.name || crusher.code || crusher.id}`.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, 160), address: '', transportModes: ['LAND', 'MARINE'], receivingCrusherId: crusher.id, active: true}));
}

/** Existing documents are projected without changing their JSON or fingerprint. */
export function stockpileLocationsForRead(state) {
  if (!Object.hasOwn(state, 'stockpileLocations')) return deriveStockpileLocations(state);
  if (!Array.isArray(state.stockpileLocations)) fail('Master lokasi tersimpan tidak valid.', 'STOCKPILE_LOCATIONS_STATE_INVALID', 409);
  const locations = state.stockpileLocations.map(location => validateShape(location));
  if (new Set(locations.map(location => location.id)).size !== locations.length || new Set(locations.map(location => location.code.toLowerCase())).size !== locations.length) fail('Master lokasi memiliki ID/kode duplikat.', 'STOCKPILE_LOCATIONS_STATE_INVALID', 409);
  return structuredClone(locations);
}

/** Called only on an authorized write draft or an explicitly approved migration. */
export function ensureStockpileLocations(state) {
  if (!Object.hasOwn(state, 'stockpileLocations')) state.stockpileLocations = deriveStockpileLocations(state);
  stockpileLocationsForRead(state);
  return state.stockpileLocations;
}

function references(state, location) {
  return [...(state.requests || []), ...(state.dispatches || []), ...(state.trips || [])].filter(record => record.destinationLocationId === location.id || record.destinationLocationSnapshot?.id === location.id || !record.destinationLocationId && record.transferMode === 'LAND' && location.receivingCrusherId !== null && (record.destinationId === location.receivingCrusherId || record.destinationCrusherId === location.receivingCrusherId));
}

export function applyStockpileLocationAction(state, action, payload, actor) {
  if (actor?.role !== 'admin' || !actor.id) fail('Hanya Admin dapat mengelola lokasi stockpile.', 'FORBIDDEN', 403);
  const draft = structuredClone(state);
  ensureStockpileLocations(draft);
  let location;
  if (action === 'master.stockpileLocation.save') {
    const validated = validateShape(payload, {allowMissingId: true});
    const previous = validated.id ? draft.stockpileLocations.find(row => row.id === validated.id) : null;
    if (validated.id && !previous) fail('Lokasi tidak ditemukan.', 'NOT_FOUND', 404);
    location = {...validated, id: previous?.id || `stockpile-location-${randomUUID()}`};
    if (draft.stockpileLocations.some(row => row.id !== location.id && row.code.toLowerCase() === location.code.toLowerCase())) fail('Kode lokasi sudah digunakan.', 'DUPLICATE', 409);
    const crusher = location.receivingCrusherId === null ? null : (draft.crushers || []).find(row => row.id === location.receivingCrusherId);
    if (location.receivingCrusherId !== null && !crusher) fail('Area penerimaan tidak ditemukan.', 'DESTINATION_INVALID', 409);
    if (location.active && location.transportModes.includes('LAND') && !crusher?.active) fail('Lokasi LAND aktif wajib memiliki area penerimaan aktif.', 'RECEIVING_AREA_REQUIRED', 409);
    if (previous && references(draft, previous).some(record => !terminal(record)) && (previous.receivingCrusherId !== location.receivingCrusherId || previous.active && !location.active || previous.transportModes.some(mode => !location.transportModes.includes(mode)))) fail('Lokasi masih dipakai permintaan/ritase terbuka; pemetaan, moda, dan status aktif dilindungi.', 'OPEN_LOCATION_REFERENCE', 409);
    if (previous) draft.stockpileLocations[draft.stockpileLocations.indexOf(previous)] = location;
    else draft.stockpileLocations.push(location);
  } else if (action === 'master.stockpileLocation.delete') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'id') || !identifier(payload.id)) fail('Hanya ID lokasi yang boleh dikirim untuk penghapusan.');
    location = draft.stockpileLocations.find(row => row.id === payload.id);
    if (!location) fail('Lokasi tidak ditemukan.', 'NOT_FOUND', 404);
    if (references(draft, location).length) fail('Lokasi memiliki riwayat transaksi; gunakan nonaktif setelah seluruh pekerjaan selesai.', 'LOCATION_IN_USE', 409);
    draft.stockpileLocations.splice(draft.stockpileLocations.indexOf(location), 1);
  } else fail('Aksi master lokasi tidak dikenal.', 'ACTION_NOT_FOUND', 404);
  stockpileLocationsForRead(draft);
  draft.events ||= [];
  draft.events.push({id: `evt-${randomUUID()}`, at: new Date().toISOString(), actorId: actor.id, role: actor.role, type: action, entityId: location.id, source: 'INTEGRATED_DEMO', synthetic: true});
  Object.assign(state, draft);
  return {entityId: location.id, locationId: location.id, message: action.endsWith('.delete') ? 'Lokasi dihapus.' : 'Lokasi tersimpan.'};
}

/** New requests require an explicit master ID. Legacy planning is opt-in. */
export function resolveStockpileDestination(state, payload, {allowLegacy = false} = {}) {
  const mode = payload.transferMode || 'MARINE';
  if (!['LAND', 'MARINE'].includes(mode)) fail('Mode harus LAND atau MARINE.', 'TRANSFER_MODE_INVALID');
  if (payload.lines !== undefined && !Array.isArray(payload.lines)) fail('Baris SKU wajib berupa array.', 'REQUEST_LINES_INVALID');
  const locations = stockpileLocationsForRead(state);
  let location;
  if (payload.destinationLocationId !== undefined && payload.destinationLocationId !== null && payload.destinationLocationId !== '') {
    if (!identifier(payload.destinationLocationId)) fail('ID lokasi tujuan tidak valid.', 'DESTINATION_LOCATION_REQUIRED');
    location = locations.find(row => row.id === payload.destinationLocationId);
    if (!location) fail('Lokasi tujuan tidak ditemukan.', 'DESTINATION_LOCATION_NOT_FOUND', 404);
  } else if (allowLegacy && mode === 'LAND' && payload.destinationId) {
    const matches = locations.filter(row => row.active && row.transportModes.includes('LAND') && row.receivingCrusherId === payload.destinationId);
    if (matches.length > 1) fail('Beberapa lokasi memakai area penerimaan ini; pilih ID lokasi secara eksplisit.', 'DESTINATION_LOCATION_AMBIGUOUS', 409);
    location = matches[0];
    if (!location) fail('Tambahkan lokasi LAND untuk area penerimaan permintaan lama.', 'DESTINATION_LOCATION_REQUIRED', 409);
  } else if (allowLegacy && mode === 'MARINE') {
    return {destinationLocationId: null, destinationLocationCode: null, destinationLocationName: null, destinationLocationSnapshot: null, destination: payload.destination || 'Legacy destination (unmapped)', destinationId: null, legacyDestinationUnmapped: true};
  } else fail('Pilih lokasi tujuan dari Master Lokasi Stockpile.', 'DESTINATION_LOCATION_REQUIRED');
  if (!location.active) fail('Lokasi tujuan nonaktif.', 'INACTIVE_DESTINATION', 409);
  if (!location.transportModes.includes(mode)) fail('Moda transport tidak didukung lokasi tujuan.', 'DESTINATION_MODE_INVALID', 409);
  let destinationId = null;
  if (mode === 'LAND') {
    const crusher = (state.crushers || []).find(row => row.id === location.receivingCrusherId);
    if (!crusher?.active) fail('Area penerimaan LAND tidak aktif atau belum dipetakan.', 'RECEIVING_AREA_REQUIRED', 409);
    destinationId = crusher.id;
    if (payload.destinationId !== undefined && payload.destinationId !== null && payload.destinationId !== '' && payload.destinationId !== destinationId) fail('Area penerimaan tidak sesuai master lokasi tujuan.', 'DESTINATION_MISMATCH', 409);
    for (const line of payload.lines || []) if (!(state.stockpiles || []).some(stock => stock.active && stock.crusherId === destinationId && stock.skuId === line.skuId && (!line.destinationStockpileId || line.destinationStockpileId === stock.id))) fail('Stockpile penerimaan untuk SKU tujuan belum tersedia.', 'DESTINATION_STOCKPILE_REQUIRED', 409);
  }
  return {destinationLocationId: location.id, destinationLocationCode: location.code, destinationLocationName: location.name, destinationLocationSnapshot: structuredClone(location), destination: location.name, destinationId, legacyDestinationUnmapped: false};
}

export function guardReceivingCrusherMutation(state, action, payload = {}) {
  if (!Object.hasOwn(state, 'stockpileLocations')) return;
  if (!['master.crusher.save', 'master.crusher.delete'].includes(action) || !payload.id) return;
  if (stockpileLocationsForRead(state).some(location => location.receivingCrusherId === payload.id && (action.endsWith('.delete') || location.active && location.transportModes.includes('LAND') && payload.active === false))) fail('Crusher masih dipetakan pada Master Lokasi Stockpile.', 'RECEIVING_LOCATION_IN_USE', 409);
}
