const list = value => Array.isArray(value) ? value : [];
const SCALE = 1000000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// Match the canonical ledger's six-decimal volume/density arithmetic. Keep
// aggregates exact and convert to a browser number only after summing.
function units(value, {positive = false, max = 1e9} = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || positive && value === 0) return null;
  const scaled = Math.round(value * Number(SCALE));
  if (!Number.isSafeInteger(scaled) || positive && scaled === 0 || Math.abs(value - scaled / Number(SCALE)) > 0.0000000001) return null;
  return BigInt(scaled);
}
const volume = value => value !== null && value <= MAX_SAFE ? Number(value) / Number(SCALE) : null;
function tonnes(value, density) {
  if (value === null || density === null) return null;
  const rounded = (value * density + SCALE / 2n) / SCALE;
  return rounded <= MAX_SAFE ? Number(rounded) / Number(SCALE) : null;
}

/** Read-only projection of exactly the role-visible context supplied by the UI.
 * Missing balances may be permission-redacted. They are unknown, never zero.
 * "Stockpile" means a unique inventory-bin ID, not a delivery-location master.
 */
export function buildInventorySummary({stockpiles = [], products = [], inventoryVisible = true} = {}) {
  const issues = [], bySku = new Map(), productById = new Map(), duplicateProducts = new Set();
  for (const product of list(products)) {
    if (!product?.id) {issues.push('MISSING_SKU_ID'); continue;}
    if (productById.has(product.id)) {duplicateProducts.add(product.id); continue;}
    productById.set(product.id, product);
  }
  const uniquePiles = new Map(), duplicatePiles = new Set();
  for (const [index, pile] of list(stockpiles).entries()) {
    if (!pile) continue;
    const key = pile.id || `__unidentified_stockpile_${index}`;
    if (uniquePiles.has(key)) {duplicatePiles.add(key); continue;}
    uniquePiles.set(key, pile);
  }
  if (duplicatePiles.size) issues.push('DUPLICATE_STOCKPILE_ID');
  if (duplicateProducts.size) issues.push('DUPLICATE_SKU_ID');

  const counts = {total: uniquePiles.size, withStock: 0, empty: 0, knownStocked: 0, knownEmpty: 0, needsReview: 0, unknownSku: 0};
  for (const [key, pile] of uniquePiles) {
    const physical = units(pile.onHandM3), knownSku = productById.has(pile.skuId) && !duplicateProducts.has(pile.skuId);
    const unambiguous = !!pile.id && !duplicatePiles.has(key);
    if (!knownSku && physical !== 0n) counts.unknownSku++;
    if (!unambiguous || physical === null || physical > 0n && !knownSku) counts.needsReview++;
    else if (physical === 0n) counts.knownEmpty++;
    else counts.knownStocked++;
    const skuId = pile.skuId || '__unassigned_sku__';
    if (!bySku.has(skuId)) bySku.set(skuId, []);
    bySku.get(skuId).push({pile, ambiguous: !unambiguous});
  }
  // Incomplete classification cannot support a truthful total of full/empty
  // bins. Known subtotals remain available as a caption, including for Jetty.
  counts.withStock = !inventoryVisible || counts.needsReview ? null : counts.knownStocked;
  counts.empty = !inventoryVisible || counts.needsReview ? null : counts.knownEmpty;

  const skuIds = [...productById.keys(), ...[...bySku.keys()].filter(id => !productById.has(id))];
  const skuRows = skuIds.map(skuId => {
    const product = productById.get(skuId), matching = bySku.get(skuId) || [], rowIssues = [];
    const density = units(product?.densityTPerM3, {positive: true, max: 5});
    if (!product) rowIssues.push('UNKNOWN_SKU');
    if (duplicateProducts.has(skuId)) rowIssues.push('DUPLICATE_SKU_ID');
    if (density === null) rowIssues.push('DENSITY_UNAVAILABLE');
    let onHand = 0n, reserved = 0n, physicalValid = !duplicateProducts.has(skuId), reservedValid = physicalValid, freeValid = physicalValid, withStockCount = 0;
    for (const {pile, ambiguous} of matching) {
      const physical = units(pile.onHandM3), reservation = units(pile.reservedM3);
      if (ambiguous) {physicalValid = reservedValid = freeValid = false; rowIssues.push('STOCKPILE_ID_UNAVAILABLE_OR_DUPLICATE');}
      if (physical === null) {physicalValid = freeValid = false; rowIssues.push('BALANCE_UNAVAILABLE');}
      else {onHand += physical; if (physical > 0n) withStockCount++;}
      if (reservation === null) {reservedValid = freeValid = false; rowIssues.push('RESERVATION_UNAVAILABLE');}
      else reserved += reservation;
      if (physical !== null && reservation !== null && reservation > physical) {freeValid = false; rowIssues.push('RESERVATION_EXCEEDS_ON_HAND');}
    }
    if (!inventoryVisible) rowIssues.push('BALANCE_RESTRICTED');
    const physicalUnits = physicalValid && inventoryVisible ? onHand : null, reservedUnits = reservedValid && inventoryVisible ? reserved : null;
    const availableUnits = physicalValid && reservedValid && freeValid && inventoryVisible ? onHand - reserved : null;
    const physicalM3 = volume(physicalUnits), reservedM3 = volume(reservedUnits), availableM3 = volume(availableUnits);
    if ((physicalUnits !== null && physicalM3 === null) || (reservedUnits !== null && reservedM3 === null) || (availableUnits !== null && availableM3 === null)) rowIssues.push('TOTAL_OUT_OF_RANGE');
    return {skuId, skuCode: product?.code || (skuId === '__unassigned_sku__' ? '' : skuId), name: product?.name || '', knownSku: !!product, densityTPerM3: volume(density), stockpileCount: inventoryVisible ? matching.length : null, withStockCount: inventoryVisible ? withStockCount : null, physicalM3, physicalTonnes: tonnes(physicalUnits, density), reservedM3, reservedTonnes: tonnes(reservedUnits, density), availableM3, availableTonnes: tonnes(availableUnits, density), issues: [...new Set(rowIssues)]};
  });
  return {counts, skuRows, issues: [...new Set(issues)], inventoryVisible, basis: 'ROLE_VISIBLE_RECORDED_STOCK'};
}
