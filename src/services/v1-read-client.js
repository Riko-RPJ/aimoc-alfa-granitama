/**
 * API v1 read client for later feature-by-feature migration.
 * Intentionally not substituted into live legacy presentation until
 * transactional/evidence DTOs are fully available.
 */
export class V1ReadError extends Error {
  constructor(message,{status=0,code='REQUEST_FAILED'}={}) {
    super(message);this.name='V1ReadError';this.status=status;this.code=code;
  }
}
export async function readV1(path,{signal,fetchImpl=fetch}={}){
  if(typeof path!=='string'||!/^\/api\/v1\/[a-zA-Z0-9/?=&_{}.-]+$/.test(path))
    throw new V1ReadError('Only same-origin API v1 read paths are allowed.',{code:'INVALID_API_PATH'});
  let response;
  try{response=await fetchImpl(path,{method:'GET',credentials:'same-origin',
    headers:{Accept:'application/json'},signal});}
  catch(error){if(error?.name==='AbortError')throw error;
    throw new V1ReadError('API v1 connection unavailable.',{code:'NETWORK_UNAVAILABLE'});}
  let payload;
  try{payload=await response.json();}catch{
    throw new V1ReadError('Invalid JSON from API v1.',{status:response.status,code:'INVALID_RESPONSE'});
  }
  if(!response.ok)throw new V1ReadError(payload.message||'API v1 request failed.',
    {status:response.status,code:payload.error||'REQUEST_FAILED'});
  if(payload?.schema_version!=='1.0'||typeof payload.resource!=='string'||
      !['READY','EMPTY','STALE','NOT_INTEGRATED'].includes(payload.data_status))
    throw new V1ReadError('Unrecognized API v1 data contract.',{code:'CONTRACT_MISMATCH'});
  return payload;
}
