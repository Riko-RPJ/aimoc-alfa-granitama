import {DomainError} from './domain.mjs';
import {isDispatchSourceArea} from '../shared/inventory-areas.mjs';

const SCALE = 1000000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const fail = (message, code, status = 400) => {throw new DomainError(message, code, status);};
const active = row => row?.active === true;
const unique = values => [...new Set(values)];

// Canonical inventory quantities/density have six decimal places. Keep their
// products exact until the final aggregate, rather than rounding each pile.
function units(value, {positive = false, max = 1e9} = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || positive && value === 0) return null;
  const scaled = Math.round(value * Number(SCALE));
  if (!Number.isSafeInteger(scaled) || positive && scaled === 0 || Math.abs(value - scaled / Number(SCALE)) > 0.0000000001) return null;
  return BigInt(scaled);
}
function volume(value) {return value !== null && value <= MAX_SAFE ? Number(value) / Number(SCALE) : null;}
function tonnes(value, density) {
  if (value === null || density === null) return null;
  const rounded = (value * density + SCALE / 2n) / SCALE;
  return rounded <= MAX_SAFE ? Number(rounded) / Number(SCALE) : null;
}
function countKeys(rows, key) {
  const counts = new Map();
  for (const row of rows) {const value = key(row); counts.set(value, (counts.get(value) || 0) + 1);}
  return counts;
}

/** Read-only global SKU totals for actors who can create transfer requests.
 *  Tonnes are density-converted ledger volumes, never scale/camera evidence.
 *  Stock/Driver actors do not receive this global inventory projection.
 */
export function summarizeSkuStocks(state, actor, {transferMode = 'MARINE', destinationCrusherId = null} = {}) {
  if (!actor?.id || actor.active === false || !['admin', 'jetty'].includes(actor.role)) fail('Total stok SKU hanya tersedia bagi pembuat permintaan transfer.', 'FORBIDDEN_SCOPE', 403);
  if (!state || !['products', 'stockpiles', 'crushers', 'jetties'].every(key => Array.isArray(state[key]))) fail('Data inventori belum lengkap.', 'STOCK_STATE_INVALID', 409);
  if (actor.role === 'jetty' && !(actor.jettyIds || []).some(id => state.jetties.some(jetty => jetty.id === id && active(jetty)))) fail('Akun tidak memiliki jetty aktif yang ditugaskan.', 'FORBIDDEN_SCOPE', 403);
  if (!['MARINE', 'LAND'].includes(transferMode)) fail('Moda harus MARINE atau LAND.', 'TRANSFER_MODE_INVALID');
  if (actor.role === 'jetty' && transferMode === 'LAND') fail('Operator jetty hanya dapat meminta transfer MARINE.', 'FORBIDDEN_SCOPE', 403);
  if (transferMode === 'LAND' && destinationCrusherId !== null && (typeof destinationCrusherId !== 'string' || !state.crushers.some(crusher => crusher.id === destinationCrusherId && active(crusher)))) fail('Area penerima LAND tidak aktif atau tidak terdaftar.', 'INVALID_DESTINATION');

  const destination = transferMode === 'LAND' ? destinationCrusherId : null;
  const codes = countKeys(state.products, product => String(product.code || '').trim().toUpperCase());
  const productIds = countKeys(state.products, product => product.id);
  const stockIds = countKeys(state.stockpiles, stock => stock.id);
  const crusherIds = countKeys(state.crushers, crusher => crusher.id);
  const emitted = new Set();
  const items = [];
  for (const product of state.products) {
    // An ambiguous master ID is reported once, never counted twice.
    if (emitted.has(product.id)) continue;
    emitted.add(product.id);
    const issues = [];
    const skuCode = typeof product.code === 'string' ? product.code.trim() : '';
    const identityInvalid = !product.id || !skuCode || productIds.get(product.id) !== 1 || codes.get(skuCode.toUpperCase()) !== 1;
    if (!product.id || productIds.get(product.id) !== 1) issues.push('INVALID_SKU_ID');
    if (!skuCode || codes.get(skuCode.toUpperCase()) !== 1) issues.push('DUPLICATE_OR_MISSING_SKU_CODE');
    const density = units(product.densityTPerM3, {positive: true, max: 5});
    if (density === null) issues.push('INVALID_DENSITY');
    const stocks = state.stockpiles.filter(stock => stock.skuId === product.id);
    let onHand = 0n, reserved = 0n, eligible = 0n;
    let physicalValid = !identityInvalid, reservedValid = !identityInvalid, freeValid = !identityInvalid, eligibleValid = !identityInvalid;
    let eligibleStockpileCount = 0;
    for (const stock of stocks) {
      const physical = units(stock.onHandM3), reservation = units(stock.reservedM3);
      if (!stock.id || stockIds.get(stock.id) !== 1) {issues.push('DUPLICATE_OR_MISSING_STOCKPILE_ID'); physicalValid = reservedValid = freeValid = eligibleValid = false;}
      if (physical === null) {issues.push('INVALID_ON_HAND'); physicalValid = freeValid = eligibleValid = false;}
      else onHand += physical;
      if (reservation === null) {issues.push('INVALID_RESERVATION'); reservedValid = freeValid = eligibleValid = false;}
      else reserved += reservation;
      if (physical !== null && reservation !== null && reservation > physical) {issues.push('RESERVATION_EXCEEDS_ON_HAND'); freeValid = eligibleValid = false;}
      const crusher = state.crushers.find(row => row.id === stock.crusherId);
      if (!crusher || crusherIds.get(stock.crusherId) !== 1) {issues.push('UNKNOWN_OR_AMBIGUOUS_CRUSHER'); eligibleValid = false;}
      const sourceEligible = active(product) && active(stock) && isDispatchSourceArea(crusher) && crusher.id !== destination;
      if (sourceEligible) {
        eligibleStockpileCount++;
        if (physical !== null && reservation !== null && reservation <= physical) eligible += physical - reservation;
      }
    }
    const physicalUnits = physicalValid ? onHand : null;
    const reservedUnits = reservedValid ? reserved : null;
    const availableUnits = physicalValid && reservedValid && freeValid ? onHand - reserved : null;
    const needsDestination = transferMode === 'LAND' && destination === null;
    const eligibleUnits = eligibleValid && !needsDestination ? eligible : null;
    const physicalM3 = volume(physicalUnits), reservedM3 = volume(reservedUnits), availableM3 = volume(availableUnits), sourceEligibleAvailableM3 = volume(eligibleUnits);
    const physicalTonnes = tonnes(physicalUnits, density), reservedTonnes = tonnes(reservedUnits, density), availableTonnes = tonnes(availableUnits, density), sourceEligibleAvailableTonnes = tonnes(eligibleUnits, density);
    if ((physicalUnits !== null && physicalM3 === null) || (reservedUnits !== null && reservedM3 === null) || (availableUnits !== null && availableM3 === null) || (eligibleUnits !== null && sourceEligibleAvailableM3 === null) || (density !== null && physicalUnits !== null && physicalTonnes === null)) issues.push('TOTAL_OUT_OF_RANGE');
    const uniqueIssues = unique(issues);
    items.push({skuId: product.id, skuCode, densityTPerM3: density === null ? null : volume(density), physicalM3, physicalTonnes, reservedM3, reservedTonnes, availableM3, availableTonnes, sourceEligibleAvailableM3, sourceEligibleAvailableTonnes, stockpileCount: stocks.length, eligibleStockpileCount, requestable: active(product), status: uniqueIssues.length ? 'INVALID_DATA' : 'READY', sourceEligibilityStatus: needsDestination ? 'DESTINATION_REQUIRED' : eligibleUnits === null || density === null || sourceEligibleAvailableTonnes === null ? 'INVALID_DATA' : 'READY', issues: uniqueIssues});
  }
  return {source: 'CANONICAL_STOCK_LEDGER', measurementBasis: 'DENSITY_CONVERTED_VOLUME', scope: 'GLOBAL_SKU_TOTALS', transferMode, destinationCrusherId: destination, unmappedStockpileCount: state.stockpiles.filter(stock => !productIds.has(stock.skuId)).length, items};
}
