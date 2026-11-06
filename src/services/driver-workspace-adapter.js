/**
 * Driver workspace adapter. An explicit UAT simulation remains client-only.
 * Real staging calls always use same-origin v1 endpoints and user CSRF.
 * No fallback from unavailable staging to invented trips.
 */
export const DRIVER_SOURCE = Object.freeze({
  STAGING: 'STAGING',
  UAT_SIMULATION: 'UAT_SIMULATION',
});
export const DRIVER_STATE = Object.freeze({
  LOADING:'LOADING',READY:'READY',EMPTY:'EMPTY',NOT_INTEGRATED:'NOT_INTEGRATED',
  NO_ASSIGNMENT:'NO_ASSIGNMENT',PENDING_DRIVER_VERIFICATION:'PENDING_DRIVER_VERIFICATION',
  STALE:'STALE',ERROR:'ERROR',FORBIDDEN:'FORBIDDEN',
});
const allowedStates = new Set(Object.values(DRIVER_STATE));
const activeStates = new Set(['QUEUED','START_AUTHORIZED','TARE_CONFIRMED','LOADING','GROSS_CONFIRMED',
  'IN_TRANSIT','ARRIVED','UNLOADED_VERIFIED','RETURNING','ON_HOLD']);
const safeId = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const httpError = (code,message,status) => Object.assign(new Error(message),{code,status});
const numericOrNull = v => v===null||v===undefined||v===''?null:(Number.isFinite(Number(v))?Number(v):null);
const safeText = x => typeof x==='string'&&x.trim()?x:null;
export function normalizeCrusherDestination(raw) {
  const source=raw?.crusher_destination;
  if(!source||typeof source!=='object'||typeof source.crusher_id!=='string')return null;
  const point=source.loading_point;
  const latitude=source.latitude??point?.latitude??null;
  const longitude=source.longitude??point?.longitude??null;
  const numericLatitude=latitude===null?null:Number(latitude);
  const numericLongitude=longitude===null?null:Number(longitude);
  // Never infer verified coordinates from numeric values alone.
  return {
    crusherId:source.crusher_id,name:safeText(source.crusher_name),
    zone:safeText(source.zone),
    loadingPoint:point?.id?{id:point.id,name:safeText(point.name)}:null,
    latitude:Number.isFinite(numericLatitude)?numericLatitude:null,
    longitude:Number.isFinite(numericLongitude)?numericLongitude:null,
    verified:source.location_status==='VERIFIED'&&source.verification_source==='SITE_APPROVED',
    accessNotes:safeText(source.access_notes),
  };
}
export function normalizeDriverTrip(raw) {
  if(!raw||typeof raw!=='object')return null;
  const id=raw.trip_id??raw.id;
  if(!safeId(id))return null;
  const status=raw.current_state??raw.status??'UNKNOWN';
  return {
    id, dispatchId:raw.dispatch_id??null,
    truckId:raw.truck_id??null,truckIdentifier:raw.truck_identifier??null,
    driverId:raw.driver_id??null,assignmentId:raw.assignment_id??null,
    assignmentStatus:raw.assignment_status??null,driverUserId:raw.driver_user_id??null,
    sourceLocation:raw.source_location_id??raw.source_stockpile_id??null,
    crusherDestination:normalizeCrusherDestination(raw),
    destinationLocation:raw.destination_location_id??null,
    material:raw.sku_id??null,mode:raw.mode??null,
    status, nextAction:safeText(raw.next_action),
    tareStatus:raw.tare_status??'TARE_PENDING',tareEventId:raw.tare_event_id??null,
    tareFailureCode:safeText(raw.tare_failure_code),wimStatus:raw.wim_status??'WIM_NOT_CONNECTED',
    startedAt:raw.started_at??null,returnedAt:raw.returned_available_at??null,
    plannedT:numericOrNull(raw.planned_quantity_t),
    actualNetT:numericOrNull(raw.actual_net_t),
    checklist:Array.isArray(raw.checklist_reports)?raw.checklist_reports.map(item=>({
      itemId:item.item_id,status:item.status??'PENDING',reportedAt:item.reported_at??null,
    })):[],
    independentlyVerifiedUnload:raw.independently_verified_unload??null,
    returnVerification:raw.return_verification??null,
  };
}
export function interpretDriverEnvelope(payload,{resource}={}) {
  if(!payload||payload.schema_version!=='1.0'||typeof payload.resource!=='string'||
     !allowedStates.has(payload.data_status)||!['STAGING','V1_STAGING','NOT_INTEGRATED','LOCAL_UAT'].includes(payload.source))
    throw httpError('CONTRACT_MISMATCH','Respons API Driver tidak sesuai kontrak v1.',502);
  if(resource && payload.resource!==resource)
    throw httpError('RESOURCE_MISMATCH','Jenis data API Driver tidak sesuai.',502);
  const status=payload.data_status;
  if(status==='NOT_INTEGRATED')return {state:status,trip:null,items:[],reason:payload.reason??'Integrasi Driver belum aktif.'};
  if(status==='NO_ASSIGNMENT'||status==='PENDING_DRIVER_VERIFICATION')
    return {state:status,trip:null,items:[],reason:payload.reason??null};
  if(status==='STALE')return {state:status,trip:null,items:[],reason:'Data Driver belum diperbarui.'};
  if(status==='EMPTY')return {state:status,trip:null,items:[]};
  const data=payload.data;
  if(status==='READY'&&(!data||typeof data!=='object'))
    throw httpError('CONTRACT_MISMATCH','Data READY tidak tersedia.',502);
  const inner=data?.data_status;
  if(inner==='NOT_INTEGRATED'||inner==='EMPTY')return {state:inner,trip:null,items:[]};
  if(inner==='NO_ASSIGNMENT'||inner==='PENDING_DRIVER_VERIFICATION')
    return {state:inner,trip:null,items:[],reason:data?.reason??null};
  const trip=normalizeDriverTrip(data?.trip??(resource==='trip'?data:null));
  const items=Array.isArray(data?.items)?data.items.map(normalizeDriverTrip).filter(Boolean):[];
  return {state:status,trip,items};
}
async function requestJson(path,{fetchImpl=fetch,method='GET',csrf,body,requestId}={}) {
  if(typeof path!=='string'||!/^\/api\/v1\/[a-zA-Z0-9/_-]+$/.test(path))
    throw httpError('INVALID_PATH','Endpoint Driver tidak aman.',400);
  const options={method,credentials:'same-origin',headers:{Accept:'application/json'}};
  if(method!=='GET'){
    if(!csrf)throw httpError('CSRF_REQUIRED','Token sesi Driver tidak tersedia.',403);
    options.headers['Content-Type']='application/json';
    options.headers['X-CSRF-Token']=csrf;
    options.headers['Idempotency-Key']=requestId??crypto.randomUUID();
    options.body=JSON.stringify(body??{});
  }
  let response;
  try{response=await fetchImpl(path,options);}
  catch(error){if(error?.name==='AbortError')throw error;
    throw httpError('NETWORK_UNAVAILABLE','Koneksi ke staging API Driver gagal.',0);}
  let json;
  try{json=await response.json();}catch{throw httpError('INVALID_RESPONSE','Server tidak mengembalikan JSON.',response.status);}
  if(!response.ok)throw httpError(json.error??'REQUEST_FAILED',json.message??'Permintaan Driver gagal.',response.status);
  return json;
}
export function createDriverStagingAdapter({fetchImpl=fetch,csrf}={}) {
  return Object.freeze({
    source:DRIVER_SOURCE.STAGING,
    async getActiveTrip(){
      const payload=await requestJson('/api/v1/driver/me/active-trip',{fetchImpl});
      return interpretDriverEnvelope(payload);
    },
    async getHistory(){
      const payload=await requestJson('/api/v1/driver/me/trips',{fetchImpl});
      return interpretDriverEnvelope(payload);
    },
    async getTripDetail(tripId){
      if(!safeId(tripId))throw httpError('INVALID_TRIP_ID','ID trip tidak valid.',400);
      return interpretDriverEnvelope(await requestJson('/api/v1/trips/'+tripId,{fetchImpl}),{resource:'trip'});
    },
    async submitChecklist({tripId,itemId,status,note=null,requestId}){
      if(!safeId(tripId)||!safeId(itemId)||!['DONE','ISSUE'].includes(status))
        throw httpError('INVALID_CHECKLIST','Checklist tidak valid.',400);
      const payload=await requestJson('/api/v1/trips/'+tripId+'/checklist',{fetchImpl,csrf,method:'POST',
        requestId,body:{item_id:itemId,status,note}});
      if(payload.schema_version!=='1.0'||payload.resource!=='driver_checklist')
        throw httpError('CONTRACT_MISMATCH','Respons checklist tidak valid.',502);
      return payload.data;
    },
    async reportReturnStart({tripId,requestId}){
      if(!safeId(tripId))throw httpError('INVALID_TRIP_ID','ID trip tidak valid.',400);
      const payload=await requestJson('/api/v1/trips/'+tripId+'/return-start',{fetchImpl,csrf,method:'POST',
        requestId,body:{}});
      if(payload.schema_version!=='1.0'||payload.resource!=='driver_return')
        throw httpError('CONTRACT_MISMATCH','Respons laporan kembali tidak valid.',502);
      return payload.data;
    },
  });
}
// Deliberately no backup credential or token carried into browser storage.
export const DRIVER_CHECKLIST = Object.freeze([
  {id:'vehicle-inspection',label:'Periksa kondisi ban dan rem'},
  {id:'safety-equipment',label:'Pastikan perlengkapan keselamatan lengkap'},
  {id:'cargo-document',label:'Periksa surat jalan dan nomor trip'},
  {id:'load-secured',label:'Pastikan muatan aman sebelum berangkat'},
]);
export const DRIVER_DEMO_SCENARIOS = Object.freeze({
  ASSIGNED:'ASSIGNED',EMPTY:'EMPTY',RETURN_READY:'RETURN_READY',
});
const simulatedTrip={
  trip_id:'UAT-TRIP-0024',assignment_id:'UAT-ASG-0024',dispatch_id:'UAT-DSP-0007',
  truck_id:'UAT-TRUCK-03',truck_identifier:'B 1234 UAT',
  source_location_id:'Stockpile Utara · UAT',destination_location_id:'Jetty Marunda · UAT',
  sku_id:'Batu Split · UAT',mode:'MARINE',status:'IN_TRANSIT',
  crusher_destination:{
    crusher_id:'CR-UAT-02',crusher_name:'Crusher 02 · UAT',zone:'Zona B · UAT',
    loading_point:{id:'LP-UAT-02',name:'Loading Point 02 · UAT'},
    latitude:null,longitude:null,location_status:'UNVERIFIED',verification_source:'UAT_ONLY',
    access_notes:'Ikuti arahan petugas. Jalur pada diagram hanya skematik.'
  },

  planned_quantity_t:'32.000000',actual_net_t:null,
  started_at:'2026-11-06T03:10:00Z',returned_available_at:null,
  checklist_reports:[],
};
const simulatedHistory=[
  {trip_id:'UAT-TRIP-0018',dispatch_id:'UAT-DSP-0004',truck_id:'UAT-TRUCK-03',
   status:'RETURNED_AVAILABLE',started_at:'2026-11-04T02:00:00Z',returned_available_at:'2026-11-04T05:45:00Z'},
  {trip_id:'UAT-TRIP-0013',dispatch_id:'UAT-DSP-0002',truck_id:'UAT-TRUCK-03',
   status:'RETURNED_AVAILABLE',started_at:'2026-11-03T03:20:00Z',returned_available_at:'2026-11-03T07:40:00Z'},
];
/** In-memory-only local UI scenario; not a call to a legacy or production endpoint. */
export function createDriverDemoAdapter({scenario=DRIVER_DEMO_SCENARIOS.ASSIGNED}={}) {
  const reports=new Map();
  let returnStarted=false;
  const base=()=>scenario===DRIVER_DEMO_SCENARIOS.EMPTY?null:normalizeDriverTrip({
    ...simulatedTrip,status:returnStarted?'RETURNING':
      scenario===DRIVER_DEMO_SCENARIOS.RETURN_READY?'UNLOADED_VERIFIED':'IN_TRANSIT',
    checklist_reports:[...reports.entries()].map(([item_id,status])=>({item_id,status,reported_at:null})),
  });
  return Object.freeze({
    source:DRIVER_SOURCE.UAT_SIMULATION,
    async getActiveTrip(){const trip=base();return {state:trip?'READY':'EMPTY',trip,items:[]};},
    async getHistory(){return {state:'READY',trip:null,items:simulatedHistory.map(normalizeDriverTrip)};},
    async getTripDetail(tripId){const trip=base();return {state:trip?.id===tripId?'READY':'EMPTY',trip:trip?.id===tripId?trip:null,items:[]};},
    async submitChecklist({tripId,itemId,status}){
      if(!base()||tripId!==base().id||!DRIVER_CHECKLIST.some(x=>x.id===itemId)||!['DONE','ISSUE'].includes(status))
        throw httpError('UAT_INVALID_CHECKLIST','Checklist simulasi tidak valid.',409);
      reports.set(itemId,status);
      return {trip_id:tripId,item_id:itemId,status,evidence_authority:'UAT_SIMULATED_SELF_REPORT',
        unloading_verified:false,truck_available:false};
    },
    async reportReturnStart({tripId}){
      if(!base()||base().id!==tripId||base().status!=='UNLOADED_VERIFIED')
        throw httpError('UAT_RETURN_NOT_READY','Simulasi return hanya tersedia setelah skenario Unloaded.',409);
      returnStarted=true;
      return {trip_id:tripId,status:'RETURNING',truck_available:false,source:'UAT_SIMULATION'};
    },
  });
}
export const isActiveDriverTrip=trip=>Boolean(trip&&activeStates.has(trip.status));
