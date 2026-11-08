import qrcode from '../../vendor/qrcode-generator.js';

export const ASSIGNMENT_QR_QUIET_ZONE = 4;
export const ASSIGNMENT_QR_ERROR_CORRECTION = 'M';
export const ASSIGNMENT_QR_MAX_BYTES = 1024;
const referenceFields = Object.freeze({
  AIMOC_ASSIGNMENT_REFERENCE: Object.freeze(['v','type','requestId','dispatchId','tripId','truckId']),
  AIMOC_QUARRY_DISPATCH_PASS: Object.freeze(['v','type','dispatchId','truckId','assignedDriverUserId'])
});
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

/** Only the backend's non-authorizing reference DTO is accepted, never arbitrary tokens/URLs. */
export function buildAssignmentQr(value) {
  if (typeof value !== 'string' || !value.trim()) return {ok:false,reason:'EMPTY'};
  if (new TextEncoder().encode(value).length > ASSIGNMENT_QR_MAX_BYTES) return {ok:false,reason:'TOO_LONG'};
  let reference;
  try { reference = JSON.parse(value); } catch { return {ok:false,reason:'INVALID'}; }
  const fields=reference&&typeof reference==='object'&&typeof reference.type==='string'&&Object.hasOwn(referenceFields,reference.type)?referenceFields[reference.type]:null;
  if (!reference || Array.isArray(reference) || typeof reference !== 'object' || !fields ||
      Object.keys(reference).length !== fields.length || Object.keys(reference).some(key => !fields.includes(key)) ||
      reference.v !== 1 ||
      !fields.slice(2).every(key => identifier(reference[key]))) return {ok:false,reason:'INVALID'};
  try {
    const encoder = qrcode(0, ASSIGNMENT_QR_ERROR_CORRECTION);
    encoder.addData(value, 'Byte');
    encoder.make();
    const moduleCount = encoder.getModuleCount(), quietZone = ASSIGNMENT_QR_QUIET_ZONE;
    const size = moduleCount + quietZone * 2;
    const matrix = Array.from({length:size}, () => Array(size).fill(false));
    const paths = [];
    for (let y = 0; y < moduleCount; y++) {
      for (let x = 0; x < moduleCount; x++) {
        if (encoder.isDark(y,x)) {
          matrix[y+quietZone][x+quietZone] = true;
          paths.push(`M${x+quietZone} ${y+quietZone}h1v1h-1z`);
        }
      }
    }
    // SVG geometry contains integers only; user data is never inserted as markup.
    return {ok:true,errorCorrection:ASSIGNMENT_QR_ERROR_CORRECTION,quietZone,moduleCount,size,matrix,path:paths.join('')};
  } catch {
    return {ok:false,reason:'UNAVAILABLE'};
  }
}
