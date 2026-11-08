import { randomUUID, createHash } from 'node:crypto';
import {isDispatchSourceArea} from '../shared/inventory-areas.mjs';
import {summarizeDriverDailyTrips} from './driver-daily-summary.mjs';
import {applyDriverScan,driverScanProgress,DRIVER_TWO_SCAN_MODE} from './driver-two-scan.mjs';
import {DomainError,trimLegacyDisplayEvents} from './domain.mjs';
import {requestLifecycle,requestRevision,assertRequestChange} from './request-lifecycle.mjs';
import {ensureStockpileLocations, stockpileLocationsForRead, applyStockpileLocationAction, resolveStockpileDestination, ensureReceivingStockpilesForRequest} from './stockpile-locations.mjs';
import {scheduleAutomaticDispatch,automaticDispatchSummary,truckAvailability,assertSerialDispatchClaims,refreshAutomaticDispatchProgress as aggregate} from './automatic-dispatch.mjs';
import {QUARRY_CILEGON_WORKFLOW,isQuarryCilegon,quarryCilegonConfig,applyQuarryCilegonAction,quarryTripProjection,quarryErpFields} from './quarry-cilegon-domain.mjs';
import {quarrySourceBudgets} from './quarry-source-budgets.mjs';
import {effectiveFleetDrivers,isSimulatedFleetDriver,fleetSimulationEnabled,fleetDispatchPolicy,fleetPolicyProjection,applyFleetSimulationConfigure} from './fleet-simulation.mjs';
export {allocateAutomaticDispatch,upgradeToAutomaticDispatch} from './automatic-dispatch.mjs';

// This is an explicitly synthetic workflow over the existing operation document.
// It does not write normalized production evidence or manufacture verification.
export const INTEGRATED_DEMO_SOURCE = 'INTEGRATED_DEMO';
const SOURCE = INTEGRATED_DEMO_SOURCE;
const EPS = 0.00001;
const round = n => Math.round(n * 1e6) / 1e6;
const timestamp = () => new Date().toISOString();
const id = prefix => `${prefix}-${randomUUID()}`;
const fail = (message, code = 'VALIDATION', status = 400) => { throw new DomainError(message, code, status); };
const row = (s, key, identifier) => s[key].find(x => x.id === identifier) || fail(`${key}: data tidak ditemukan.`, 'NOT_FOUND', 404);
const numeric = (n, label, positive = false) => {
  if (n === null || n === '' || typeof n === 'boolean' || !Number.isFinite(Number(n)) || Number(n) < (positive ? 0.000001 : 0) || Number(n) > 1e9) fail(`${label} tidak valid.`);
  return round(Number(n));
};
const text = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 160) fail(`${label} tidak valid.`); return value.trim(); };
const admin = u => { if (u?.role !== 'admin') fail('Akses khusus Admin AIMOC.', 'FORBIDDEN', 403); };
const scope = (u, role, locationId) => {
  if (u?.role === 'admin') return;
  if (u?.role !== role || !(u[role === 'stock' ? 'crusherIds' : 'jettyIds'] || []).includes(locationId)) fail('Akun tidak ditugaskan pada lokasi ini.', 'FORBIDDEN', 403);
};
const driver = (u, t) => { if (u?.role !== 'driver' || u.id !== t.assignedDriverUserId) fail('Hanya pengemudi yang ditugaskan dapat menjalankan tugas ini.', 'FORBIDDEN', 403); };
const open = t => !['returned', 'cancelled'].includes(t.status);
const active = t => open(t) && !['queued','waiting_truck'].includes(t.status);
const integrated = t => t.source === SOURCE;
const list = x => Array.isArray(x) ? x : [];
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const nextCode = (prefix, rows) => `${prefix}-${String(rows.length + 1).padStart(5, '0')}`;
const locationFields = record => Object.fromEntries(['destination', 'destinationLocationId', 'destinationLocationCode', 'destinationLocationName', 'destinationLocationSnapshot', 'legacyDestinationUnmapped'].filter(key => record[key] !== undefined).map(key => [key, structuredClone(record[key])]));

function event(s, actor, action, entityId, extra = {}) {
  const result = {id: id('evt'), at: timestamp(), actorId: actor.id, actorName: actor.name || actor.username || actor.id, role: actor.role, type: action, entityId, source: SOURCE, synthetic: true, ...extra};
  s.events.push(result);
  trimLegacyDisplayEvents(s);
  return result;
}

function ledger(s, actor, type, stockpileId, volumeM3, t, tonnageT = 0) {
  s.inventoryLedger.push({id: id('led'), at: timestamp(), actorId: actor.id, type, stockpileId, volumeM3: round(volumeM3), tonnageT: round(tonnageT), referenceId: t.id, source: SOURCE, synthetic: true});
}

function erp(s, type, t) {
  s.erpOutbox.push({id: id('erp'), createdAt: timestamp(), type, entityId: t.id, status: 'awaiting_configuration', system: 'oracle_netsuite', source: SOURCE, synthetic: true, payload: {tripId: t.id, tripCode: t.code, requestId: t.requestId, dispatchId: t.dispatchId, skuId: t.skuId, volumeM3: t.volumeM3, tonnageT: t.tonnageT, sourceStockpileId: t.stockpileId, destinationStockpileId: t.destinationStockpileId || null, jettyId: t.jettyId, vesselId: t.vesselId, receiptCode: t.receiptCode || null, quantitySource: SOURCE, ...locationFields(t),...quarryErpFields(t)}});
}


function destination(s, request, skuId, requestedStockpileId) {
  const crusher = row(s, 'crushers', request.destinationId);
  if (!crusher.active) fail('Lokasi tujuan LAND nonaktif.', 'INACTIVE_DESTINATION', 409);
  const candidates = s.stockpiles.filter(x => x.active && x.crusherId === crusher.id && x.skuId === skuId);
  const result = requestedStockpileId ? candidates.find(x => x.id === requestedStockpileId) : candidates.sort((a, b) => a.code.localeCompare(b.code))[0];
  if (!result) fail('Stockpile tujuan LAND untuk SKU ini belum tersedia.', 'DESTINATION_STOCKPILE_REQUIRED', 409);
  return result;
}

/** One authoritative definition validator for create and pre-dispatch edit. */
function requestDefinition(s,p,actor){
  const transferMode=p.transferMode||'MARINE';
  if(!['LAND','MARINE'].includes(transferMode))fail('Mode harus LAND atau MARINE.','TRANSFER_MODE_INVALID');
  if(transferMode==='LAND'){admin(actor);ensureReceivingStockpilesForRequest(s,p);}
  const resolved=resolveStockpileDestination(s,{...p,transferMode});
  let jettyId=null,vesselId=null;
  if(transferMode==='MARINE'){
    const jetty=row(s,'jetties',p.jettyId),vessel=row(s,'vessels',p.vesselId);scope(actor,'jetty',jetty.id);
    if(vessel.jettyId!==jetty.id||vessel.active===false||vessel.status==='closed'||jetty.active===false)fail('Kapal dan jetty tidak cocok, nonaktif, atau sudah ditutup.');
    jettyId=jetty.id;vesselId=vessel.id;
  }
  const definition={transferMode,...resolved,jettyId,vesselId,lines:[]};
  if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 6) fail('Permintaan harus berisi 1–6 SKU.');
  const seen = new Set();
  definition.lines = p.lines.map(line => {
    if(!line||typeof line!=='object'||Array.isArray(line))fail('Baris SKU tidak valid.','REQUEST_LINES_INVALID');
    const product = row(s, 'products', line.skuId);
    if (!product.active || seen.has(product.id)) fail('SKU nonaktif atau duplikat.');
    seen.add(product.id);
    if (!['t', 'm3'].includes(line.unit)) fail('Satuan harus t atau m3.');
    const quantity = numeric(line.quantity, 'Jumlah transfer', true);
    if(transferMode==='MARINE'&&quantity>1000000)fail('Jumlah transfer tidak valid.');
    const densityTPerM3 = numeric(product.densityTPerM3, 'Berat jenis', true);
    const target=transferMode==='LAND'?destination(s,definition,product.id,line.destinationStockpileId):null;
    return {skuId: product.id, quantity, unit: line.unit, densityTPerM3, tonnageT: round(line.unit === 't' ? quantity : quantity * densityTPerM3), volumeM3: round(line.unit === 'm3' ? quantity : quantity / densityTPerM3),...(target?{destinationStockpileId:target.id}:{})};
  });
  return definition;
}

function createRequest(s, p, actor) {
  const definition=requestDefinition(s,p,actor);
  const request={id:id('req'),code:nextCode('TR',s.requests),...definition,status:'requested',requestedBy:actor.id,createdAt:timestamp(),deliveredM3:0,deliveredT:0,source:SOURCE,synthetic:true,quantitySource:'REQUESTED_DEMO',requestRevision:1};
  if(definition.transferMode==='MARINE'&&s.quarryCilegon?.enabled===true&&s.quarryCilegon.defaultWorkflow===QUARRY_CILEGON_WORKFLOW)request.workflow=QUARRY_CILEGON_WORKFLOW;
  s.requests.push(request);
  event(s, actor, 'request.created', request.id);
  return {entityId:request.id,requestId:request.id,source:SOURCE,requestRevision:1,message:definition.transferMode==='MARINE'?'Permintaan transfer dibuat.':undefined};
}

function updateRequest(s,p,actor){
  admin(actor);
  const request=row(s,'requests',p.requestId),revision=assertRequestChange(s,request,actor,p.expectedRequestRevision);
  const allowed=new Set(['requestId','expectedRequestRevision','transferMode','destinationLocationId','jettyId','vesselId','lines']);
  if(Object.keys(p).some(key=>!allowed.has(key))||!['LAND','MARINE'].includes(p.transferMode))fail('Field perubahan permintaan tidak dikenali.','REQUEST_FIELD_INVALID');
  if(Array.isArray(p.lines)&&p.lines.some(line=>!line||typeof line!=='object'||Array.isArray(line)||Object.keys(line).some(key=>!['skuId','quantity','unit','destinationStockpileId'].includes(key))))fail('Kirim SKU, kuantitas, dan satuan asli; hasil konversi ditentukan server.','REQUEST_FIELD_INVALID');
  const before={transferMode:request.transferMode,...locationFields(request),jettyId:request.jettyId,vesselId:request.vesselId,lines:structuredClone(request.lines),workflow:request.workflow||null};
  const definition=requestDefinition(s,p,actor),at=timestamp();
  Object.assign(request,definition,{editedAt:at,editedBy:actor.id,requestRevision:revision+1,remainingT:round(definition.lines.reduce((sum,line)=>sum+line.tonnageT,0)),remainingM3:round(definition.lines.reduce((sum,line)=>sum+line.volumeM3,0))});
  if(definition.transferMode==='LAND'&&request.workflow===QUARRY_CILEGON_WORKFLOW)delete request.workflow;
  else if(before.transferMode==='LAND'&&definition.transferMode==='MARINE'&&!request.workflow&&s.quarryCilegon?.enabled===true&&s.quarryCilegon.defaultWorkflow===QUARRY_CILEGON_WORKFLOW)request.workflow=QUARRY_CILEGON_WORKFLOW;
  event(s,actor,'request.updated',request.id,{before,after:{transferMode:request.transferMode,...locationFields(request),jettyId:request.jettyId,vesselId:request.vesselId,lines:structuredClone(request.lines),workflow:request.workflow||null},requestRevision:request.requestRevision});
  return {entityId:request.id,requestId:request.id,source:SOURCE,requestRevision:request.requestRevision,message:'Permintaan transfer diperbarui.'};
}

function cancelRequest(s,p,actor){
  admin(actor);
  const request=row(s,'requests',p.requestId),revision=assertRequestChange(s,request,actor,p.expectedRequestRevision);
  if(Object.keys(p).some(key=>!['requestId','expectedRequestRevision','reason'].includes(key))||p.reason!==undefined&&(typeof p.reason!=='string'||p.reason.length>500))fail('Alasan pembatalan maksimal 500 karakter.','REQUEST_FIELD_INVALID');
  const at=timestamp(),reason=typeof p.reason==='string'?p.reason.trim():'';
  Object.assign(request,{status:'cancelled',cancelledAt:at,cancelledBy:actor.id,cancelReason:reason||null,requestRevision:revision+1,remainingT:0,remainingM3:0,pendingTrips:0,deliveryStatus:'cancelled'});
  event(s,actor,'request.cancelled',request.id,{reason:reason||null,requestRevision:request.requestRevision});
  return {entityId:request.id,requestId:request.id,source:SOURCE,requestRevision:request.requestRevision,message:'Permintaan transfer dibatalkan.'};
}

function driverCatalog(drivers) {
  return list(drivers).filter(u => u && u.id && u.role === 'driver' && u.active !== false && u.disabled !== true);
}

function planRequest(s, p, actor, options) {
  admin(actor);
  const request = row(s, 'requests', p.requestId);
  if (!integrated(request)) fail('Permintaan ini bukan workflow demo terintegrasi.', 'SOURCE_MISMATCH', 409);
  if(request.status==='cancelled'||request.cancelledAt||request.cancelledBy)fail('Permintaan sudah dibatalkan.','REQUEST_CANCELLED',409);
  if (request.status !== 'requested') fail('Permintaan sudah direncanakan.', 'ALREADY_PLANNED', 409);
  const eligibility=requestLifecycle(s,request,actor);
  if(!eligibility.canEdit)fail(eligibility.requestActionBlockedReason,eligibility.requestActionBlockedCode,409);
  if (p.destinationLocationId !== undefined && request.destinationLocationId && p.destinationLocationId !== request.destinationLocationId) fail('Lokasi tujuan permintaan tidak boleh diganti melalui perencanaan.', 'DESTINATION_MISMATCH', 409);
  ensureReceivingStockpilesForRequest(s, {...request, ...(p.destinationLocationId === undefined ? {} : {destinationLocationId: p.destinationLocationId})});
  const resolved = resolveStockpileDestination(s, {...request, ...(p.destinationLocationId === undefined ? {} : {destinationLocationId: p.destinationLocationId})}, {allowLegacy: true});
  if (!request.destinationLocationSnapshot) Object.assign(request, resolved);
  else if (request.transferMode === 'LAND' && (request.destinationLocationSnapshot.receivingCrusherId !== resolved.destinationId || request.destinationId !== resolved.destinationId)) fail('Snapshot area penerimaan tidak sesuai lokasi tujuan.', 'DESTINATION_MISMATCH', 409);
  if(['assignments','truckId','driverUserId','assignedDriverUserId'].some(key=>p[key]!==undefined))fail('Alokasi truk dan pengemudi dilakukan otomatis; assignment manual tidak diperbolehkan.','MANUAL_ASSIGNMENT_NOT_ALLOWED',400);
  const trucks = s.trucks.filter(t => t.active);
  const marine = request.transferMode === 'MARINE';
  const vessel = marine ? row(s, 'vessels', request.vesselId) : null;
  const requestedT = round(request.lines.reduce((sum, line) => sum + line.tonnageT, 0));
  if (vessel && (vessel.active === false || vessel.status === 'closed' || vessel.jettyId !== request.jettyId || row(s, 'jetties', request.jettyId).active === false)) fail('Tujuan kapal/jetty tidak tersedia.', 'INACTIVE_DESTINATION', 409);
  if (vessel && requestedT > vessel.payloadLimitT - vessel.loadedT - vessel.reservedT + EPS) fail('Sisa kapasitas kapal termasuk reservasi tidak cukup.', 'VESSEL_CAPACITY', 409);
  const dispatch = {id: id('dsp'), code: nextCode('DSP', s.dispatches), requestId: request.id, transferMode: request.transferMode, source: SOURCE, synthetic: true, ...locationFields(request), destinationId: request.destinationId || null, jettyId: request.jettyId, vesselId: request.vesselId, allocations: [], tripIds: [], status: 'planned', createdAt: timestamp(), completedTrips: 0, deliveredM3: 0, deliveredT: 0};
  if(isQuarryCilegon(request)){dispatch.workflow=QUARRY_CILEGON_WORKFLOW;dispatch.allocationPolicy=fleetDispatchPolicy(s);}
  let sequence = s.trips.reduce((max, t) => Math.max(max, t.sequence || 0), 0);
  let estimatedTrips=0;
  for (const line of request.lines) {
    const product = row(s, 'products', line.skuId);
    if (!product.active) fail('SKU nonaktif.', 'INACTIVE_SOURCE', 409);
    const target = marine ? null : destination(s, request, line.skuId, line.destinationStockpileId);
    const stocks = s.stockpiles.filter(stock => stock.active && stock.skuId === line.skuId && isDispatchSourceArea(row(s, 'crushers', stock.crusherId)) && (marine || stock.crusherId !== request.destinationId)).sort((a, b) => (b.onHandM3 - b.reservedM3) - (a.onHandM3 - a.reservedM3) || a.code.localeCompare(b.code));
    const sourceCapacities=trucks.filter(truck=>Number.isFinite(truck.bedM3)&&truck.bedM3>0&&Number.isFinite(truck.payloadLimitT)&&truck.payloadLimitT>0).map(truck=>Math.min(truck.payloadLimitT,truck.bedM3*line.densityTPerM3));
    // Source fan-out is useful only for parallel pairs and more than one load.
    // A busy eligible pair still counts: waiting work keeps its source plan.
    const eligibleDrivers=driverCatalog(options.drivers).filter(driver=>!isSimulatedFleetDriver(driver)||dispatch.allocationPolicy?.simulatedDrivers===true&&fleetSimulationEnabled(s));
    const balanceSources=isQuarryCilegon(request)&&sourceCapacities.length>=2&&new Set(eligibleDrivers.map(driver=>driver.id)).size>=2&&line.tonnageT>Math.max(...sourceCapacities)+EPS&&new Set(stocks.filter(stock=>stock.onHandM3>stock.reservedM3).map(stock=>stock.crusherId)).size>=2;
    const sourceBudgets=balanceSources?quarrySourceBudgets(stocks,line):null;
    if(balanceSources)dispatch.sourceAllocationMode='BALANCED_CRUSHERS';
    let remainingT = line.tonnageT;
    for (const stock of stocks) {
      const availableM3 = round(stock.onHandM3 - stock.reservedM3);
      const sourceT = sourceBudgets?(sourceBudgets.get(stock.id)?.tonnageT||0):round(Math.min(remainingT, availableM3 * line.densityTPerM3));
      const sourceBudgetM3 = sourceBudgets?(sourceBudgets.get(stock.id)?.volumeM3||0):round(Math.min(availableM3, sourceT / line.densityTPerM3));
      const allocation = {stockpileId: stock.id, crusherId: stock.crusherId, skuId: line.skuId, volumeM3: 0, tonnageT: 0};
      if (sourceT > 0) {
        if (dispatch.tripIds.length >= 2000 || s.trips.length >= 20000) fail('Rencana melampaui batas 2.000 ritase.', 'TRIP_LIMIT', 409);
        const capacities=(trucks.length?trucks:s.trucks).map(truck=>Math.min(truck.payloadLimitT,truck.bedM3*line.densityTPerM3)).filter(cap=>Number.isFinite(cap)&&cap>0);
        estimatedTrips+=capacities.length?Math.ceil((sourceT-EPS)/Math.min(...capacities)):1;
        if(estimatedTrips>2000||s.trips.length+estimatedTrips>20000)fail('Rencana melampaui batas 2.000 ritase.','TRIP_LIMIT',409);
        const tonnageT=sourceT,volumeM3=sourceBudgetM3;
        if (volumeM3 <= 0) fail('Kuantitas terlalu kecil untuk presisi volume demo.', 'QUANTITY_PRECISION', 409);
        if (round(stock.reservedM3 + volumeM3) > stock.onHandM3) fail('Pembulatan reservasi melebihi stok tersedia.', 'INSUFFICIENT_STOCK', 409);
        const trip = {id: id('trip'), code: nextCode('RIT', s.trips), source: SOURCE, synthetic: true, quantitySource: 'PLANNED_DEMO', requestId: request.id, dispatchId: dispatch.id, transferMode: request.transferMode, ...locationFields(request), stockpileId: stock.id, crusherId: stock.crusherId, skuId: line.skuId, destinationId: request.destinationId || null, destinationStockpileId: target?.id || null, destinationCrusherId: target?.crusherId || null, truckId:null,assignedDriverUserId:null,assignmentMode:'AUTOMATIC',jettyId: request.jettyId, vesselId: request.vesselId, densityTPerM3: line.densityTPerM3, volumeM3, tonnageT, status:'waiting_truck',sequence:++sequence,queueSequence:sequence,createdAt:timestamp(),estimatedStartAt:null,estimatedReturnAt:null,weighingEvents:[]};
        if(isQuarryCilegon(request))trip.workflow=QUARRY_CILEGON_WORKFLOW;
        s.trips.push(trip);
        dispatch.tripIds.push(trip.id);
        stock.reservedM3 = round(stock.reservedM3 + volumeM3);
        allocation.volumeM3 = round(allocation.volumeM3 + volumeM3);
        allocation.tonnageT = round(allocation.tonnageT + tonnageT);
        remainingT = round(remainingT - tonnageT);
      }
      if (allocation.tonnageT > 0) dispatch.allocations.push(allocation);
      if (remainingT === 0) break;
    }
    if (remainingT > 0) fail(`Stok tersedia ${product.name} tidak mencukupi.`, 'INSUFFICIENT_STOCK', 409);
  }
  dispatch.stockpileIds = [...new Set(dispatch.allocations.map(a => a.stockpileId))];
  dispatch.crusherIds = [...new Set(dispatch.allocations.map(a => a.crusherId))];
  dispatch.skuIds = [...new Set(dispatch.allocations.map(a => a.skuId))];
  for (const [key, values] of [['stockpileId', dispatch.stockpileIds], ['crusherId', dispatch.crusherIds], ['skuId', dispatch.skuIds]]) dispatch[key] = values.length === 1 ? values[0] : null;
  dispatch.tonnageT = round(dispatch.allocations.reduce((sum, a) => sum + a.tonnageT, 0));
  dispatch.volumeM3 = round(dispatch.allocations.reduce((sum, a) => sum + a.volumeM3, 0));
  s.dispatches.push(dispatch);
  if (vessel) vessel.reservedT = round(vessel.reservedT + dispatch.tonnageT);
  Object.assign(request, {dispatchId: dispatch.id, status: 'planned', plannedAt: timestamp(), plannedBy: actor.id, planningStatus: 'INTEGRATED_DEMO',requestRevision:requestRevision(request)+1});
  event(s, actor, 'request.planned', request.id);
  const scheduling=scheduleAutomaticDispatch(s,options,actor);
  aggregate(s);
  return {entityId: request.id, requestId: request.id, dispatchIds: [dispatch.id], tripIds: dispatch.tripIds, source: SOURCE,...scheduling,autoDispatch:automaticDispatchSummary(s,dispatch.id)};
}

function checkTarget(s, t) {
  if (t.transferMode === 'LAND') {
    const target = row(s, 'stockpiles', t.destinationStockpileId);
    if (!target.active || !row(s, 'crushers', target.crusherId).active || target.skuId !== t.skuId || target.crusherId !== t.destinationCrusherId) fail('Tujuan stockpile tidak sesuai atau nonaktif.', 'DESTINATION_MISMATCH', 409);
  } else {
    const vessel = row(s, 'vessels', t.vesselId);
    if (vessel.active === false || vessel.status === 'closed' || vessel.jettyId !== t.jettyId || row(s, 'jetties', t.jettyId).active === false) fail('Kapal/jetty tujuan tidak tersedia.', 'INACTIVE_DESTINATION', 409);
  }
}

function reconcile(t) {
  if (t.status !== 'start_pending' || !t.qrScannedAt) return;
  const pending = list(t.weighingEvents).find(e => e.type === 'TARE' && e.status === 'PENDING');
  if (pending) {
    pending.status = 'ACCEPTED'; pending.acceptedAt = timestamp();
    t.tareT = pending.weightT; t.tareEventId = pending.id; t.tareAt = pending.acceptedAt;
  }
  if (t.tareT !== undefined) { t.status = 'ready_to_load'; t.readyToLoadAt = timestamp(); }
}

function moveTrip(s, action, p, actor, options) {
  const t = row(s, 'trips', p.tripId);
  if (!integrated(t)) fail('Ritase ini bukan demo terintegrasi.', 'SOURCE_MISMATCH', 409);
  if(isQuarryCilegon(t)&&!options.quarryGateAuthorized&&!['start','loading','arrive','receive','return_start'].includes(action))fail('Gunakan scan gerbang Quarry Cilegon untuk QR, timbang, dan verifikasi kembali.','QUARRY_GATE_REQUIRED',409);
  for (const key of ['truckId', 'skuId', 'stockpileId', 'jettyId', 'vesselId', 'destinationStockpileId']) if (p[key] !== undefined && p[key] !== t[key]) fail('Truk, SKU, atau tujuan tidak sesuai dispatch.', 'DESTINATION_MISMATCH', 409);
  const stock = row(s, 'stockpiles', t.stockpileId);
  const sourceScope = () => scope(actor, 'stock', stock.crusherId);
  const destinationScope = () => scope(actor, t.transferMode === 'LAND' ? 'stock' : 'jetty', t.transferMode === 'LAND' ? t.destinationCrusherId : t.jettyId);
  const isState = (...statuses) => { if (!statuses.includes(t.status)) fail(`Status ${t.status}; tindakan membutuhkan ${statuses.join('/')}.`, 'INVALID_TRANSITION', 409); };
  if(options.quarryGateAuthorized)sourceScope();
  else if (action === 'qr') admin(actor);
  else if (['start', 'return_start'].includes(action)) driver(actor, t);
  else if (['arrive', 'receive'].includes(action)) destinationScope();
  else sourceScope();
  if(t.driverScanMode===DRIVER_TWO_SCAN_MODE)fail('Ritase ini menggunakan dua scan Driver. Lanjutkan melalui konfirmasi scan Driver.','DRIVER_TWO_SCAN_REQUIRED',409);
  if(t.status==='waiting_truck')fail('Muatan menunggu truk dan pengemudi tersedia; belum dapat dieksekusi.','WAITING_FOR_TRUCK',409);
  const eventId = p.externalEventId ?? p.eventId;
  const normalized = {...p}; delete normalized.externalEventId; delete normalized.eventId;
  const digest = fingerprint({action, payload: normalized});
  if (eventId !== undefined) {
    text(eventId, 'ID event');
    const prior = s.events.find(e => e.source === SOURCE && e.externalEventId === eventId);
    if (prior) {
      if (prior.eventFingerprint !== digest || prior.entityId !== t.id || prior.actorId !== actor.id) fail('ID event digunakan dengan isi berbeda.', 'EVENT_CONFLICT', 409);
      return {entityId: t.id, tripId: t.id, source: SOURCE, replayed: true, status: t.status};
    }
  }
  if (action === 'qr') {
    isState('queued', 'start_pending', 'ready_to_load');
    if (t.qrScannedAt) fail('QR ritase sudah dipindai.', 'ALREADY_RECORDED', 409);
    t.qrScannedAt = timestamp(); t.qrScannedBy = actor.id; t.qrSource = SOURCE;
  } else if (action === 'tare') {
    isState('queued', 'start_pending');
    if (t.weighingEvents.some(e => e.type === 'TARE')) fail('Tare sudah direkam.', 'ALREADY_RECORDED', 409);
    t.weighingEvents.push({id: id('weigh'), type: 'TARE', weightT: numeric(p.weightT, 'Tare', true), status: 'PENDING', at: timestamp(), actorId: actor.id, source: SOURCE, synthetic: true});
  } else if (action === 'start') {
    isState('queued');
    assertSerialDispatchClaims(s);
    const truck = row(s, 'trucks', t.truckId);
    if (!truck.active || !driverCatalog(options.drivers).some(d => d.id === t.assignedDriverUserId)) fail('Truk atau driver tidak aktif.', 'ASSIGNMENT_UNAVAILABLE', 409);
    if (s.trips.some(other => other.id !== t.id && active(other) && (other.truckId === t.truckId || other.assignedDriverUserId === t.assignedDriverUserId))) fail('Truk atau pengemudi masih menjalankan tugas lain.', 'TRUCK_OR_DRIVER_BUSY', 409);
    if (s.trips.some(other => other.id !== t.id && open(other) && other.sequence < t.sequence && (other.truckId === t.truckId || other.assignedDriverUserId === t.assignedDriverUserId))) fail('Selesaikan tugas sebelumnya secara serial.', 'QUEUE_ORDER', 409);
    if (!stock.active || !row(s, 'crushers', stock.crusherId).active || !row(s, 'products', t.skuId).active) fail('Sumber stockpile/SKU nonaktif.', 'INACTIVE_SOURCE', 409);
    checkTarget(s, t);
    t.status = 'start_pending'; t.startedAt = timestamp();
    t.estimatedReturnAt = new Date(Date.now() + truck.cycleMinutes * 60000).toISOString();
  } else if (action === 'loading') {
    isState('ready_to_load');
    if (!stock.active || !row(s, 'crushers', stock.crusherId).active || !row(s, 'products', t.skuId).active) fail('Sumber stockpile/SKU nonaktif.', 'INACTIVE_SOURCE', 409);
    checkTarget(s, t);
    t.status = 'loading'; t.loadingAt = timestamp();
  } else if (action === 'gross') {
    isState('loading');
    if (t.tareT === undefined || !t.tareEventId) fail('Tare wajib tersedia.', 'TARE_REQUIRED', 409);
    const grossT = numeric(p.weightT, 'Gross', true), netT = round(grossT - t.tareT);
    if (netT <= 0 || Math.abs(netT - t.tonnageT) > EPS) fail('Netto harus sesuai rencana demo. Selisih/underload memerlukan rencana baru; tidak ditandai selesai.', 'WEIGHT_RECONCILIATION', 409);
    const truck = row(s, 'trucks', t.truckId);
    if (netT > truck.payloadLimitT + EPS || t.volumeM3 > truck.bedM3 + EPS) fail('Muatan melebihi kapasitas truk.', 'TRUCK_CAPACITY', 409);
    const measurement = {id: id('weigh'), type: 'GROSS', weightT: grossT, netT, status: 'ACCEPTED', at: timestamp(), actorId: actor.id, source: SOURCE, synthetic: true};
    t.weighingEvents.push(measurement);
    Object.assign(t, {grossT, netT, grossEventId: measurement.id, grossAt: measurement.at, quantitySource: SOURCE, status: 'weighed'});
  } else if (action === 'depart') {
    isState('weighed');
    if (!t.qrScannedAt || !t.tareEventId || !t.grossEventId || Math.abs(round(t.grossT - t.tareT) - t.tonnageT) > EPS) fail('QR, tare, dan gross yang valid wajib tersedia.', 'WEIGHING_REQUIRED', 409);
    checkTarget(s, t);
    if (!stock.active || !row(s, 'crushers', stock.crusherId).active || !row(s, 'products', t.skuId).active) fail('Sumber tidak aktif.', 'INACTIVE_SOURCE', 409);
    if (stock.onHandM3 + EPS < t.volumeM3 || stock.reservedM3 + EPS < t.volumeM3) fail('Stok/reservasi tidak cukup.', 'STOCK_CONFLICT', 409);
    stock.onHandM3 = round(stock.onHandM3 - t.volumeM3); stock.reservedM3 = round(Math.max(0, stock.reservedM3 - t.volumeM3));
    t.status = 'in_transit'; t.departedAt = timestamp();
    ledger(s, actor, 'transfer_departed', stock.id, -t.volumeM3, t, -t.tonnageT); erp(s, 'stock_transfer_departed', t);
  } else if (action === 'arrive') {
    isState('in_transit'); checkTarget(s, t);
    t.status = 'arrived'; t.arrivedAt = timestamp();
  } else if (action === 'receive') {
    isState('arrived'); checkTarget(s, t);
    if (t.transferMode === 'LAND') {
      const target = row(s, 'stockpiles', t.destinationStockpileId);
      target.onHandM3 = round(target.onHandM3 + t.volumeM3);
      ledger(s, actor, 'stock_transfer_received', target.id, t.volumeM3, t, t.tonnageT);
    } else {
      const vessel = row(s, 'vessels', t.vesselId);
      if (vessel.status !== 'loading') fail('Kapal belum berstatus loading.', 'VESSEL_NOT_LOADING', 409);
      if (vessel.loadedT + t.tonnageT > vessel.payloadLimitT + EPS || vessel.reservedT + EPS < t.tonnageT) fail('Kapasitas/reservasi kapal tidak cukup.', 'VESSEL_CAPACITY', 409);
      vessel.loadedT = round(vessel.loadedT + t.tonnageT); vessel.reservedT = round(Math.max(0, vessel.reservedT - t.tonnageT));
      ledger(s, actor, 'vessel_received', stock.id, 0, t, t.tonnageT);
    }
    const receiptMax = s.trips.reduce((max, trip) => Math.max(max, Number(/^RCV-(\d+)$/.exec(trip.receiptCode || '')?.[1] || 0)), 0);
    Object.assign(t, {status: 'unloaded', receivedAt: timestamp(), unloadedAt: timestamp(), receivedBy: actor.id, receiptCode: `RCV-${String(receiptMax + 1).padStart(5, '0')}`});
    erp(s, 'stock_transfer_received', t);
  } else if (action === 'return_start') {
    isState('unloaded'); t.status = 'returning'; t.returnStartedAt = timestamp();
  } else if (action === 'return') {
    isState('returning');
    t.status = 'returned'; t.returnedAt = timestamp(); t.returnVerifiedBy = actor.id;
  } else fail('Tindakan ritase tidak didukung.', 'ACTION_NOT_FOUND', 404);
  reconcile(t);
  const audit = event(s, actor, `trip.${action}`, t.id, eventId === undefined ? {} : {externalEventId: eventId, eventFingerprint: digest});
  if (action === 'qr') t.qrEventId = audit.id;
  const scheduling=action==='return'?scheduleAutomaticDispatch(s,options,actor):{};
  aggregate(s);
  return {entityId: t.id, tripId: t.id, source: SOURCE, status: t.status,...scheduling};
}

/** Apply to a draft and replace only after validation, including direct callers. */
export function applyIntegratedAction(state, action, payload, actor, options = {}) {
  if (!actor?.id || !['admin', 'stock', 'jetty', 'driver'].includes(actor.role)) fail('Akun tidak berwenang.', 'FORBIDDEN', 403);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('Payload wajib berupa object.');
  const draft = structuredClone(state);
  options={...options,drivers:effectiveFleetDrivers(draft,options.drivers)};
  for (const key of ['products', 'crushers', 'stockpiles', 'trucks', 'jetties', 'vessels', 'requests', 'dispatches', 'trips', 'inventoryLedger', 'events', 'erpOutbox']) if (!Array.isArray(draft[key])) fail('Dokumen operasional tidak lengkap.', 'STATE_INVALID', 409);
  ensureStockpileLocations(draft);
  let result;
  if(action==='fleet.simulation.configure')result=applyFleetSimulationConfigure(draft,payload,actor);
  else if (typeof action==='string'&&action.startsWith('quarry.')) result=applyQuarryCilegonAction(draft,action,payload,actor,options,{createRequest:p=>createRequest(draft,p,actor),planRequest:p=>planRequest(draft,p,actor,options),moveTrip:(a,p,o)=>moveTrip(draft,a,p,actor,o)});
  else if (['master.stockpileLocation.save', 'master.stockpileLocation.delete'].includes(action)) result = applyStockpileLocationAction(draft, action, payload, actor);
  else if (action === 'request.create') result = createRequest(draft, payload, actor);
  else if (action === 'request.update') result = updateRequest(draft, payload, actor);
  else if (action === 'request.cancel') result = cancelRequest(draft, payload, actor);
  else if (action === 'request.plan') result = planRequest(draft, payload, actor, options);
  else if (action === 'trip.driver_scan') result = applyDriverScan(draft,payload,actor,options);
  else if (typeof action === 'string' && action.startsWith('trip.')) result = moveTrip(draft, action.slice(5), payload, actor, options);
  else fail('Tindakan demo tidak didukung.', 'ACTION_NOT_FOUND', 404);
  if((action==='trip.driver_scan'||action==='quarry.gate.scan')&&result.replayed===true)return result;
  draft.updatedAt = timestamp();
  Object.assign(state, draft);
  return result;
}

/** Role-scoped data; occupancy is computed BEFORE scope filtering. */
export function integratedView(state, actor, options = {}) {
  if (!actor?.id || !['admin', 'stock', 'jetty', 'driver'].includes(actor.role)) fail('Akun tidak berwenang.', 'FORBIDDEN', 403);
  options={...options,drivers:effectiveFleetDrivers(state,options.drivers)};
  const view = structuredClone(state);
  delete view.driverDailySummary;
  view.stockpileLocations = stockpileLocationsForRead(state);
  const allTrips = state.trips;
  const fleet = state.trucks.map(truck => {
    const global = truckAvailability(state,truck);
    const claims=allTrips.filter(t=>t.truckId===truck.id&&open(t));
    const canSee=t=>!!t&&(actor.role==='admin'||t.assignedDriverUserId===actor.id||actor.role==='stock'&&((actor.crusherIds||[]).includes(t.crusherId)||(actor.crusherIds||[]).includes(t.destinationCrusherId))||actor.role==='jetty'&&(actor.jettyIds||[]).includes(t.jettyId));
    const visibleDispatches=global.dispatchIds.filter(id=>claims.some(t=>t.dispatchId===id&&canSee(t)));
    return {...truck,...global,dispatchId:visibleDispatches.includes(global.dispatchId)?global.dispatchId:null,dispatchIds:visibleDispatches,activeTripId:canSee(claims.find(t=>t.id===global.activeTripId))?global.activeTripId:null,nextTripId:canSee(claims.find(t=>t.id===global.nextTripId))?global.nextTripId:null};
  });
  const visible = t => integrated(t) && (actor.role === 'admin' || actor.role === 'driver' && t.assignedDriverUserId === actor.id || actor.role === 'stock' && ((actor.crusherIds || []).includes(t.crusherId) || (actor.crusherIds || []).includes(t.destinationCrusherId)) || actor.role === 'jetty' && (actor.jettyIds || []).includes(t.jettyId));
  view.trips = allTrips.filter(visible).map(t => {
    const result = structuredClone(t), allowed = [];
    const sourceStock = state.stockpiles.find(stock => stock.id === t.stockpileId);
    const targetStock = state.stockpiles.find(stock => stock.id === t.destinationStockpileId);
    result.sourceStockpileCode = sourceStock?.code || null;
    result.sourceCrusherCode = state.crushers.find(c => c.id === t.crusherId)?.code || null;
    result.destinationStockpileCode = targetStock?.code || null;
    result.destinationCrusherCode = state.crushers.find(c => c.id === t.destinationCrusherId)?.code || null;
    const assignedDriver = driverCatalog(options.drivers).find(d => d.id === t.assignedDriverUserId);
    result.driverName = assignedDriver?.name || assignedDriver?.displayName || assignedDriver?.username || t.assignedDriverUserId;
    result.qrStatus = t.qrScannedAt ? 'SCANNED' : 'NOT_SCANNED';
    const sourceAllowed = actor.role === 'admin' || actor.role === 'stock' && (actor.crusherIds || []).includes(t.crusherId);
    const destinationAllowed = actor.role === 'admin' || actor.role === (t.transferMode === 'LAND' ? 'stock' : 'jetty') && (actor[t.transferMode === 'LAND' ? 'crusherIds' : 'jettyIds'] || []).includes(t.transferMode === 'LAND' ? t.destinationCrusherId : t.jettyId);
    const assigned = actor.role === 'driver' && actor.id === t.assignedDriverUserId;
    const blocked = allTrips.find(other => other.id !== t.id && open(other) && other.truckId && (other.truckId === t.truckId || other.assignedDriverUserId === t.assignedDriverUserId) && (active(other) || other.sequence < t.sequence));
    const driverActive = driverCatalog(options.drivers).some(d => d.id === t.assignedDriverUserId);
    result.canStart = assigned && t.status === 'queued' && !blocked && driverActive && state.trucks.find(truck => truck.id === t.truckId)?.active === true;
    result.blockReason = t.status==='waiting_truck'?'WAITING_FOR_TRUCK':t.status === 'queued' && blocked ? 'PREVIOUS_TRIP_NOT_RETURNED' : t.status === 'queued' && !driverActive ? 'DRIVER_INACTIVE' : t.status === 'start_pending' ? !t.qrScannedAt ? 'QR_REQUIRED' : 'TARE_REQUIRED' : null;
    if (actor.role === 'admin' && ['queued', 'start_pending', 'ready_to_load'].includes(t.status) && !t.qrScannedAt) allowed.push('trip.qr');
    if (sourceAllowed && ['queued', 'start_pending'].includes(t.status) && !list(t.weighingEvents).some(e => e.type === 'TARE')) allowed.push('trip.tare');
    if (result.canStart) allowed.push('trip.start');
    if (sourceAllowed && t.status === 'ready_to_load') allowed.push('trip.loading');
    if (sourceAllowed && t.status === 'loading') allowed.push('trip.gross');
    if (sourceAllowed && t.status === 'weighed') allowed.push('trip.depart');
    if (destinationAllowed && t.status === 'in_transit') allowed.push('trip.arrive');
    if (destinationAllowed && t.status === 'arrived' && (t.transferMode === 'LAND' || state.vessels.find(v => v.id === t.vesselId)?.status === 'loading')) allowed.push('trip.receive');
    if (assigned && t.status === 'unloaded') allowed.push('trip.return_start');
    if (sourceAllowed && t.status === 'returning') allowed.push('trip.return');
    result.driverScan=driverScanProgress(state,t,actor,options);
    result.displayStatus=t.driverScanMode===DRIVER_TWO_SCAN_MODE&&t.status==='returned'?'completed':t.status;
    result.allowedActions = t.driverScanMode===DRIVER_TWO_SCAN_MODE?(result.driverScan.canScan?['trip.driver_scan']:[]):[...allowed,...(result.driverScan.canScan?['trip.driver_scan']:[])];
    if(isQuarryCilegon(t)){
      result.quarry=quarryTripProjection(state,t,actor,options);
      result.driverScan={mode:QUARRY_CILEGON_WORKFLOW,phase:'QUARRY_WORKFLOW',nextStage:null,canScan:false,reason:'QUARRY_GATE_REQUIRED',quantityBasis:'SCALE_SIMULATION',measurementPending:!t.grossEventId};
      result.allowedActions=allowed.filter(action=>['trip.start','trip.loading','trip.arrive','trip.receive','trip.return_start'].includes(action));
      if(result.quarry.allowedPurposes.length)result.allowedActions.push('quarry.gate.scan');
    }
    return result;
  });
  const tripIds = new Set(view.trips.map(t => t.id));
  const dispatchIds = new Set(view.trips.map(t => t.dispatchId));
  const requestIds = new Set(view.trips.map(t => t.requestId));
  const requestVisible = r => integrated(r) && (actor.role === 'admin' || requestIds.has(r.id) || actor.role === 'jetty' && (actor.jettyIds || []).includes(r.jettyId));
  view.requests = view.requests.filter(requestVisible).map(request=>({...request,...requestLifecycle(state,request,actor)}));
  view.dispatches = view.dispatches.filter(d => integrated(d) && (actor.role === 'admin' || dispatchIds.has(d.id)));
  if (actor.role !== 'admin') {
    delete view.automaticDispatchUpgrade;
    view.dispatches = view.dispatches.map(d => {
      const assignedTrips = view.trips.filter(t => t.dispatchId === d.id);
      const stockIds = new Set(assignedTrips.map(t => t.stockpileId));
      const allocations = list(d.allocations).filter(a => stockIds.has(a.stockpileId)).map(a => {
        const subset = assignedTrips.filter(t => t.stockpileId === a.stockpileId && t.skuId === a.skuId);
        return {...a, volumeM3: round(subset.reduce((sum, t) => sum + t.volumeM3, 0)), tonnageT: round(subset.reduce((sum, t) => sum + t.tonnageT, 0))};
      });
      const received = assignedTrips.filter(t => t.receivedAt);
      return {...d, tripIds: assignedTrips.map(t => t.id), allocations, stockpileIds: [...stockIds], crusherIds: [...new Set(assignedTrips.map(t => t.crusherId))], skuIds: [...new Set(assignedTrips.map(t => t.skuId))], stockpileId: stockIds.size === 1 ? [...stockIds][0] : null, crusherId: new Set(assignedTrips.map(t => t.crusherId)).size === 1 ? assignedTrips[0].crusherId : null, skuId: new Set(assignedTrips.map(t => t.skuId)).size === 1 ? assignedTrips[0].skuId : null, volumeM3: round(assignedTrips.reduce((sum, t) => sum + t.volumeM3, 0)), tonnageT: round(assignedTrips.reduce((sum, t) => sum + t.tonnageT, 0)), deliveredM3: round(received.reduce((sum, t) => sum + t.volumeM3, 0)), deliveredT: round(received.reduce((sum, t) => sum + t.tonnageT, 0)), remainingT: round(assignedTrips.filter(t => !t.receivedAt).reduce((sum, t) => sum + t.tonnageT, 0)), deliveryStatus: received.length === assignedTrips.length ? 'received' : received.length ? 'partial' : 'pending', status: assignedTrips.every(t => t.status === 'returned') ? 'completed' : assignedTrips.some(t => !['queued','waiting_truck'].includes(t.status)) ? 'in_progress' : 'planned', completedTrips: assignedTrips.filter(t => t.status === 'returned').length, receivedTrips: received.length, pendingTrips: assignedTrips.filter(open).length,autoDispatch:automaticDispatchSummary({...state,trips:assignedTrips},d.id),scoped: true};
    });
    view.requests = view.requests.map(request => {
      const assignedTrips = view.trips.filter(t => t.requestId === request.id);
      if (!assignedTrips.length) return {...request, lines: [],autoDispatch:automaticDispatchSummary({...state,trips:[]}),scoped: true};
      const skus = new Set(assignedTrips.map(t => t.skuId));
      const received = assignedTrips.filter(t => t.receivedAt);
      const lines = request.lines.filter(line => skus.has(line.skuId)).map(line => {
        const subset = assignedTrips.filter(t => t.skuId === line.skuId);
        const tonnageT = round(subset.reduce((sum, t) => sum + t.tonnageT, 0)), volumeM3 = round(subset.reduce((sum, t) => sum + t.volumeM3, 0));
        return {...line, tonnageT, volumeM3, quantity: line.unit === 't' ? tonnageT : volumeM3};
      });
      const deliveredT = round(received.reduce((sum, t) => sum + t.tonnageT, 0));
      return {...request, lines, deliveredT, deliveredM3: round(received.reduce((sum, t) => sum + t.volumeM3, 0)), remainingT: round(lines.reduce((sum, line) => sum + line.tonnageT, 0) - deliveredT), deliveryStatus: received.length === assignedTrips.length ? 'received' : received.length ? 'partial' : 'pending', status: assignedTrips.every(t => t.status === 'returned') ? 'completed' : assignedTrips.some(t => !['queued','waiting_truck'].includes(t.status)) ? 'in_progress' : 'planned', pendingTrips: assignedTrips.filter(open).length,autoDispatch:automaticDispatchSummary({...state,trips:assignedTrips}),scoped: true};
    });
    view.events = view.events.filter(e => tripIds.has(e.entityId));
    view.erpOutbox = [];
    view.inventoryLedger = view.inventoryLedger.filter(e => tripIds.has(e.referenceId));
    view.measurements = actor.role === 'stock' ? view.measurements.filter(m => (actor.crusherIds || []).includes(m.crusherId)) : [];
    if (actor.role === 'stock') {
      view.stockpiles = view.stockpiles.filter(x => (actor.crusherIds || []).includes(x.crusherId));
      view.crushers = view.crushers.filter(x => (actor.crusherIds || []).includes(x.id));
    } else if (actor.role === 'driver') {
      const stockIds = new Set(view.trips.flatMap(t => [t.stockpileId, t.destinationStockpileId]));
      view.stockpiles = view.stockpiles.filter(x => stockIds.has(x.id)).map(({onHandM3, reservedM3, ...s}) => s);
      const ids = new Set(view.stockpiles.map(s => s.crusherId));
      view.crushers = view.crushers.filter(x => ids.has(x.id));
    } else { view.stockpiles = []; view.crushers = []; }
    const visibleJettyIds = new Set(view.trips.map(t => t.jettyId));
    const visibleVesselIds = new Set(view.trips.map(t => t.vesselId));
    if (actor.role === 'jetty') for (const identifier of actor.jettyIds || []) visibleJettyIds.add(identifier);
    view.jetties = view.jetties.filter(j => visibleJettyIds.has(j.id));
    view.vessels = view.vessels.filter(v => actor.role === 'jetty' ? visibleJettyIds.has(v.jettyId) : visibleVesselIds.has(v.id));
  }
  view.trucks = fleet;
  view.fleet = fleet;
  view.drivers = driverCatalog(options.drivers).filter(d => !isSimulatedFleetDriver(d)&&(actor.role === 'admin' || d.id === actor.id)).map(d => ({id: d.id, name: d.name || d.displayName || d.username || d.id, username: d.username, role: 'driver', active: true}));
  view.fleetPolicy=fleetPolicyProjection(state,options.drivers,actor);
  view.integratedDemo = {source: SOURCE, synthetic: true, productionEvidence: false, netsuitePosting: 'awaiting_configuration', activeTrips: fleet.filter(t => t.status === 'busy').length,autoDispatch:automaticDispatchSummary(actor.role==='admin'?state:{...state,trips:view.trips})};
  view.quarryCilegon=quarryCilegonConfig(state);
  const sum = (rows, field) => round(rows.reduce((total, item) => total + (item[field] || 0), 0));
  view.metrics = {onHandM3: sum(view.stockpiles, 'onHandM3'), reservedM3: sum(view.stockpiles, 'reservedM3'), availableM3: round(sum(view.stockpiles, 'onHandM3') - sum(view.stockpiles, 'reservedM3')), inTransitM3: sum(view.trips.filter(t => ['in_transit', 'arrived'].includes(t.status)), 'volumeM3'), deliveredM3: sum(view.trips.filter(t => t.receivedAt), 'volumeM3'), deliveredT: sum(view.trips.filter(t => t.receivedAt), 'tonnageT'), availableTrucks: fleet.filter(t => t.status === 'available').length, busyTrucks: fleet.filter(t => t.status === 'busy').length, allocatedTrucks: fleet.filter(t => t.status === 'allocated').length, activeTrips: view.trips.filter(active).length, queuedTrips: view.trips.filter(t => t.status === 'queued').length, completedTrips: view.trips.filter(t => t.status === 'returned').length, openRequests: view.requests.filter(r => !['completed','cancelled'].includes(r.status)).length, erpPending: view.erpOutbox.length};
  for (const stock of view.stockpiles) if (stock.onHandM3 !== undefined) stock.availableM3 = round(stock.onHandM3 - stock.reservedM3);
  for (const vessel of view.vessels) vessel.remainingT = round(vessel.payloadLimitT - vessel.loadedT - vessel.reservedT);
  view.access = {role: actor.role, crusherIds: actor.crusherIds || [], jettyIds: actor.jettyIds || []};
  if(actor.role==='driver')view.driverDailySummary=summarizeDriverDailyTrips(state,actor,{now:options.now,includeCarryover:true});
  view.erpStatus = 'awaiting_configuration';
  return view;
}
