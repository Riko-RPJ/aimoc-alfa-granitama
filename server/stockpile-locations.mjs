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

/** Derive only legacy physical-crusher areas; never turn logical receivers into machines. */
export function deriveStockpileLocations(state) {
  const crushers = (state.crushers || []).filter(crusher => crusher.active === true && crusher.kind !== 'RECEIVING_AREA' && crusher.production !== false);
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

function editablePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('Lokasi harus berupa object.');
  const managed = ['code', 'active', 'receivingCrusherId'];
  if (managed.some(key => Object.hasOwn(payload, key))) fail('Kode, status, dan pemetaan lokasi dikelola sistem.', 'STOCKPILE_LOCATION_MANAGED_FIELD');
  if (Object.keys(payload).some(key => !['id', 'name', 'address', 'transportModes'].includes(key))) fail('Field lokasi tidak sesuai kontrak.');
  if (payload.id !== undefined && !identifier(payload.id)) fail('ID lokasi tidak valid.');
  if (!Array.isArray(payload.transportModes) || !payload.transportModes.length || payload.transportModes.length > 2 || new Set(payload.transportModes).size !== payload.transportModes.length || payload.transportModes.some(mode => !['LAND', 'MARINE'].includes(mode))) fail('Moda transport harus LAND dan/atau MARINE.');
  return {...(payload.id === undefined ? {} : {id: payload.id}), name: string(payload.name, 'Nama lokasi', 160), address: string(payload.address ?? '', 'Alamat lokasi', 500, true), transportModes: ['LAND', 'MARINE'].filter(mode => payload.transportModes.includes(mode))};
}

function allocateCode(state) {
  const historical = [...state.stockpileLocations, ...(state.requests || []).map(row => ({code: row.destinationLocationCode || row.destinationLocationSnapshot?.code})), ...(state.dispatches || []).map(row => ({code: row.destinationLocationCode || row.destinationLocationSnapshot?.code})), ...(state.trips || []).map(row => ({code: row.destinationLocationCode || row.destinationLocationSnapshot?.code})), ...(state.events || []).map(row => ({code: row.locationCode}))];
  const used = new Set(historical.filter(row => typeof row.code === 'string').map(row => row.code.toUpperCase()));
  let sequence = state.stockpileLocationSequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail('Sequence kode lokasi tidak valid.', 'STOCKPILE_LOCATIONS_STATE_INVALID', 409);
  for (const code of used) {const match = /^SPL-(\d+)$/.exec(code);if (match) {const value = Number(match[1]);if (!Number.isSafeInteger(value)) fail('Kode lokasi historis melampaui rentang aman.', 'STOCKPILE_LOCATIONS_STATE_INVALID', 409);sequence = Math.max(sequence, value);}}
  let code;
  do {if (sequence >= Number.MAX_SAFE_INTEGER) fail('Kode lokasi habis.', 'STOCKPILE_LOCATION_CODE_EXHAUSTED', 409);code = `SPL-${String(++sequence).padStart(6, '0')}`;} while (used.has(code));
  state.stockpileLocationSequence = sequence;
  return code;
}

const boundedCode = (value, seed) => value.length <= 64 ? value : `${value.slice(0, 47)}-${createHash('sha256').update(seed).digest('hex').slice(0, 16).toUpperCase()}`;

function validateManagedReceivingArea(state, location, area) {
  if (area.kind !== 'RECEIVING_AREA' && area.managedBy !== 'STOCKPILE_LOCATION') return false;
  if (area.kind !== 'RECEIVING_AREA' || area.managedBy !== 'STOCKPILE_LOCATION' || area.stockpileLocationId !== location.id || area.production !== false || area.sourceEligible !== false || (state.stockpileLocations || []).some(row => row.id !== location.id && row.receivingCrusherId === area.id) || (state.crushers || []).some(row => row.id !== area.id && row.managedBy === 'STOCKPILE_LOCATION' && row.stockpileLocationId === location.id)) fail('Pemetaan persediaan penerima sistem tidak valid.', 'STOCKPILE_LOCATIONS_STATE_INVALID', 409);
  return true;
}

function provisionReceivingStockpiles(state, location, area, products) {
  if (products.some(product => !identifier(product.id)) || new Set(products.map(product => product.id)).size !== products.length) fail('Identitas SKU aktif tidak valid/duplikat.', 'STOCKPILE_LOCATIONS_STATE_INVALID', 409);
  const stocks = state.stockpiles || [];
  const usedStockCodes = new Set(stocks.map(row => String(row.code || '').toLowerCase()));
  const created = [];
  for (const [index, product] of products.entries()) {
    // An inactive target is a deliberate master decision, never a reason to create a bypass.
    if (stocks.some(stock => stock.crusherId === area.id && stock.skuId === product.id)) continue;
    let code = boundedCode(`${location.code}-SKU-${String(index + 1).padStart(3, '0')}`, location.id + ':' + product.id);
    while (usedStockCodes.has(code.toLowerCase())) code = `SP-${randomUUID()}`;
    usedStockCodes.add(code.toLowerCase());
    created.push({id: `stock-${randomUUID()}`, code, crusherId: area.id, skuId: product.id, onHandM3: 0, reservedM3: 0, active: true, kind: 'RECEIVING_STOCKPILE', managedBy: 'STOCKPILE_LOCATION', stockpileLocationId: location.id});
  }
  if (created.length) {state.stockpiles ||= [];state.stockpiles.push(...created);}
  return created.map(stock => stock.id);
}

/** Dedicated zero-balance logical inventory, never an inferred physical crusher. */
function ensureManagedReceivingArea(state, location) {
  state.crushers ||= []; state.stockpiles ||= [];
  let area = location.receivingCrusherId === null ? null : state.crushers.find(row => row.id === location.receivingCrusherId);
  if (area) return area;
  if (location.receivingCrusherId !== null) fail('Area penerimaan lama tidak ditemukan.', 'DESTINATION_INVALID', 409);
  const usedAreaCodes = new Set(state.crushers.map(row => String(row.code || '').toLowerCase()));
  let code = boundedCode(`RCV-${location.code}`, location.id);
  while (usedAreaCodes.has(code.toLowerCase())) code = `RCV-${randomUUID()}`;
  area = {id: `receiving-area-${randomUUID()}`, code, name: `Persediaan ${location.name}`.slice(0, 160), active: true, kind: 'RECEIVING_AREA', production: false, sourceEligible: false, managedBy: 'STOCKPILE_LOCATION', stockpileLocationId: location.id};
  state.crushers.push(area);
  location.receivingCrusherId = area.id;
  const products = (state.products || []).filter(row => row.active === true);
  provisionReceivingStockpiles(state, location, area, products);
  return area;
}

/** WRITE ONLY: synchronize future SKUs on an authorized operation draft, never during GET/resolve. */
export function ensureReceivingStockpilesForRequest(state, payload) {
  if (payload?.transferMode !== 'LAND') return {createdStockpileIds: [], receivingAreaId: null};
  if (!Array.isArray(payload.lines)) fail('Baris SKU wajib berupa array.', 'REQUEST_LINES_INVALID');
  const resolved = resolveStockpileDestination(state, {...payload, lines: []}, {allowLegacy: true});
  const location = stockpileLocationsForRead(state).find(row => row.id === resolved.destinationLocationId);
  const area = (state.crushers || []).find(row => row.id === resolved.destinationId);
  if (!validateManagedReceivingArea(state, location, area)) return {createdStockpileIds: [], receivingAreaId: area.id};
  const activeProducts = (state.products || []).filter(row => row.active === true);
  if (activeProducts.some(product => !identifier(product.id)) || new Set(activeProducts.map(product => product.id)).size !== activeProducts.length) fail('Identitas SKU aktif tidak valid/duplikat.', 'STOCKPILE_LOCATIONS_STATE_INVALID', 409);
  if (payload.lines.some(line => !line || typeof line !== 'object' || Array.isArray(line) || !identifier(line.skuId))) fail('Baris SKU tidak valid.', 'REQUEST_LINES_INVALID');
  const requestedIds = new Set(payload.lines.map(line => line.skuId));
  const products = activeProducts.filter(product => requestedIds.has(product.id));
  if (products.length !== requestedIds.size) fail('SKU tujuan tidak ditemukan atau nonaktif.', 'DESTINATION_STOCKPILE_REQUIRED', 409);
  const createdStockpileIds = provisionReceivingStockpiles(state, location, area, products);
  return {createdStockpileIds, receivingAreaId: area.id};
}

function removeUnusedManagedReceivingArea(state, location) {
  const area = (state.crushers || []).find(row => row.id === location.receivingCrusherId && row.kind === 'RECEIVING_AREA' && row.managedBy === 'STOCKPILE_LOCATION' && row.stockpileLocationId === location.id);
  if (!area) return;
  const stocks = (state.stockpiles || []).filter(stock => stock.crusherId === area.id);
  const stockIds = new Set(stocks.map(stock => stock.id));
  if (stocks.some(stock => stock.managedBy !== 'STOCKPILE_LOCATION' || stock.stockpileLocationId !== location.id || stock.onHandM3 !== 0 || stock.reservedM3 !== 0) || (state.inventoryLedger || []).some(row => stockIds.has(row.stockpileId)) || (state.measurements || []).some(row => stockIds.has(row.stockpileId)) || (state.trips || []).some(row => row.crusherId === area.id || row.destinationCrusherId === area.id || stockIds.has(row.stockpileId) || stockIds.has(row.destinationStockpileId)) || state.stockpileLocations.some(row => row.id !== location.id && row.receivingCrusherId === area.id)) fail('Persediaan penerima memiliki saldo atau riwayat; lokasi tidak dapat dihapus.', 'LOCATION_IN_USE', 409);
  state.stockpiles = state.stockpiles.filter(stock => !stockIds.has(stock.id));
  state.crushers = state.crushers.filter(row => row.id !== area.id);
}

export function applyStockpileLocationAction(state, action, payload, actor) {
  if (actor?.role !== 'admin' || !actor.id) fail('Hanya Admin dapat mengelola lokasi stockpile.', 'FORBIDDEN', 403);
  const draft = structuredClone(state);
  ensureStockpileLocations(draft);
  let location;
  if (action === 'master.stockpileLocation.save') {
    const validated = editablePayload(payload);
    const previous = validated.id ? draft.stockpileLocations.find(row => row.id === validated.id) : null;
    if (validated.id && !previous) fail('Lokasi tidak ditemukan.', 'NOT_FOUND', 404);
    location = {...validated, id: previous?.id || `stockpile-location-${randomUUID()}`, code: previous?.code || allocateCode(draft), active: previous?.active ?? true, receivingCrusherId: previous?.receivingCrusherId ?? null};
    if (location.active && location.transportModes.includes('LAND') && location.receivingCrusherId === null) ensureManagedReceivingArea(draft, location);
    if (draft.stockpileLocations.some(row => row.id !== location.id && row.code.toLowerCase() === location.code.toLowerCase())) fail('Kode lokasi sudah digunakan.', 'DUPLICATE', 409);
    const crusher = location.receivingCrusherId === null ? null : (draft.crushers || []).find(row => row.id === location.receivingCrusherId);
    if (location.receivingCrusherId !== null && !crusher) fail('Area penerimaan tidak ditemukan.', 'DESTINATION_INVALID', 409);
    if (crusher) validateManagedReceivingArea(draft, location, crusher);
    if (crusher?.kind === 'RECEIVING_AREA' && crusher.managedBy === 'STOCKPILE_LOCATION' && crusher.stockpileLocationId === location.id) crusher.name = `Persediaan ${location.name}`.slice(0, 160);
    if (location.active && location.transportModes.includes('LAND') && !crusher?.active) fail('Lokasi LAND aktif wajib memiliki area penerimaan aktif.', 'RECEIVING_AREA_REQUIRED', 409);
    if (previous && references(draft, previous).some(record => !terminal(record)) && (previous.receivingCrusherId !== location.receivingCrusherId || previous.active && !location.active || previous.transportModes.some(mode => !location.transportModes.includes(mode)))) fail('Lokasi masih dipakai permintaan/ritase terbuka; pemetaan, moda, dan status aktif dilindungi.', 'OPEN_LOCATION_REFERENCE', 409);
    if (previous) draft.stockpileLocations[draft.stockpileLocations.indexOf(previous)] = location;
    else draft.stockpileLocations.push(location);
  } else if (action === 'master.stockpileLocation.delete') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'id') || !identifier(payload.id)) fail('Hanya ID lokasi yang boleh dikirim untuk penghapusan.');
    location = draft.stockpileLocations.find(row => row.id === payload.id);
    if (!location) fail('Lokasi tidak ditemukan.', 'NOT_FOUND', 404);
    if (references(draft, location).length) fail('Lokasi memiliki riwayat transaksi dan harus dipertahankan untuk menjaga referensi.', 'LOCATION_IN_USE', 409);
    removeUnusedManagedReceivingArea(draft, location);
    draft.stockpileLocations.splice(draft.stockpileLocations.indexOf(location), 1);
  } else fail('Aksi master lokasi tidak dikenal.', 'ACTION_NOT_FOUND', 404);
  stockpileLocationsForRead(draft);
  draft.events ||= [];
  draft.events.push({id: `evt-${randomUUID()}`, at: new Date().toISOString(), actorId: actor.id, role: actor.role, type: action, entityId: location.id, locationCode: location.code, source: 'INTEGRATED_DEMO', synthetic: true});
  Object.assign(state, draft);
  return {entityId: location.id, locationId: location.id, locationCode: location.code, receivingAreaId: location.receivingCrusherId, message: action.endsWith('.delete') ? 'Lokasi dihapus.' : 'Lokasi tersimpan.'};
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
