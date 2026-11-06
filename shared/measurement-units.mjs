const SCALE = 1000000n;
const MAX_QUANTITY = 1000000000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function scaled(value, {positive = false, max = MAX_QUANTITY} = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || positive && value === 0) return null;
  const units = Math.round(value * Number(SCALE));
  if (!Number.isSafeInteger(units) || positive && units === 0 || Math.abs(value - units / Number(SCALE)) > 1e-10) return null;
  return BigInt(units);
}
const number = value => value !== null && value <= MAX_SAFE ? Number(value) / Number(SCALE) : null;
const divideRounded = (numerator, denominator) => (numerator + denominator / 2n) / denominator;

/** Browser-safe preview; the server supplies the authoritative SKU density. */
export function previewMeasurementQuantity(value, unit, density) {
  const result = {valid:false,errorCode:null,quantityValue:null,quantityUnit:unit,volumeM3:null,tonnageT:null,densityTPerM3Snapshot:null};
  if (!['m3','t'].includes(unit)) return {...result,errorCode:'INVALID_MEASUREMENT_UNIT'};
  const quantity = scaled(value);
  if (quantity === null) return {...result,errorCode:'INVALID_MEASUREMENT_QUANTITY'};
  const densityUnits = scaled(density,{positive:true,max:5});
  if (unit === 't' && densityUnits === null) return {...result,errorCode:'INVALID_MEASUREMENT_DENSITY'};
  const volume = unit === 'm3' ? quantity : divideRounded(quantity * SCALE,densityUnits);
  if (volume > BigInt(MAX_QUANTITY) * SCALE || unit === 't' && quantity > 0n && volume === 0n) return {...result,errorCode:'INVALID_MEASUREMENT_CONVERSION'};
  const tonnes = unit === 't' ? quantity : densityUnits === null ? null : divideRounded(quantity * densityUnits,SCALE);
  const tonnageT = number(tonnes);
  if (tonnes !== null && tonnageT === null) return {...result,errorCode:'INVALID_MEASUREMENT_CONVERSION'};
  return {valid:true,errorCode:null,quantityValue:number(quantity),quantityUnit:unit,volumeM3:number(volume),tonnageT,densityTPerM3Snapshot:number(densityUnits)};
}
