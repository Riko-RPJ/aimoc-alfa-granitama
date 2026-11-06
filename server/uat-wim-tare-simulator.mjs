import {createHash} from 'node:crypto';

const SCENARIOS=new Set(['SUCCESS','DELAYED','DUPLICATE','INVALID','FAILURE']);
const DECIMAL=/^(0|[1-9]\d{0,8})(?:\.(\d{1,6}))?$/;

const fail=(code,message)=>{throw Object.assign(new Error(message),{code,status:422});};
const requiredString=(value,name)=>{
 if(typeof value!=='string'||!value)fail('UAT_TARE_PROFILE_INVALID',`${name} is required`);
 return value;
};
const positiveInteger=(value,name)=>{
 if(!Number.isSafeInteger(value)||value<1)fail('UAT_TARE_PROFILE_INVALID',`${name} must be a positive integer`);
 return value;
};
const timestamp=(value,name)=>{
 if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))
  fail('UAT_TARE_PROFILE_INVALID',`${name} must be an ISO timestamp with timezone`);
 return Date.parse(value);
};
const canonicalPositiveDecimal=(value,name)=>{
 const match=typeof value==='string'&&DECIMAL.exec(value);
 if(!match)fail('UAT_TARE_PROFILE_INVALID',`${name} must be a positive decimal string with at most six decimals`);
 const canonical=`${match[1]}.${(match[2]||'').padEnd(6,'0')}`;
 if(BigInt(canonical.replace('.',''))===0n)
  fail('UAT_TARE_PROFILE_INVALID',`${name} must be positive`);
 return canonical;
};
const eventId=({assignment,profile})=>'uat-tare-'+createHash('sha256').update([
 'auto-tare-uat/2',assignment.assignmentId,assignment.tripId,assignment.truckId,
 assignment.assignmentRevision,profile.revision
].join('\n')).digest('hex');

/** Deterministic isolated-UAT event generation; this function performs no I/O. */
export function createAutomaticTareEvent({assignment,profile,attempt,requestedAt}={}){
 if(!profile)fail('UAT_TARE_PROFILE_MISSING','An explicit UAT Tare profile is required');
 if(!assignment||typeof assignment!=='object'||Array.isArray(assignment))
  fail('UAT_TARE_PROFILE_INVALID','Assignment is required');

 const assignmentId=requiredString(assignment.assignmentId,'assignment.assignmentId');
 const tripId=requiredString(assignment.tripId,'assignment.tripId');
 const truckId=requiredString(assignment.truckId,'assignment.truckId');
 const assignmentRevision=positiveInteger(assignment.assignmentRevision,'assignment.assignmentRevision');
 const assignedAtMs=timestamp(assignment.assignedAt,'assignment.assignedAt');
 positiveInteger(attempt,'attempt');
 const requestedAtMs=timestamp(requestedAt,'requestedAt');

 if(profile.authority!=='UAT_SIMULATED_CONFIG'||profile.enabled!==true||
    requiredString(profile.truck_id,'profile.truck_id')!==truckId||!truckId.startsWith('UAT-'))
  fail('UAT_TARE_PROFILE_INVALID','Enabled UAT_SIMULATED_CONFIG profile must match the assigned UAT truck');
 const profileRevision=positiveInteger(profile.revision,'profile.revision');
 if(!SCENARIOS.has(profile.scenario))fail('UAT_TARE_PROFILE_INVALID','profile.scenario is unsupported');
 if(!Number.isSafeInteger(profile.delay_ms)||profile.delay_ms<0)
  fail('UAT_TARE_PROFILE_INVALID','profile.delay_ms must be a non-negative integer');
 const weightT=canonicalPositiveDecimal(profile.simulated_tare_t,'profile.simulated_tare_t');
 canonicalPositiveDecimal(profile.approved_gvw_t,'profile.approved_gvw_t');
 canonicalPositiveDecimal(profile.approved_payload_t,'profile.approved_payload_t');

 const correlationId=`auto-tare:${tripId}:${assignmentRevision}`;
 const externalEventId=eventId({assignment:{assignmentId,tripId,truckId,assignmentRevision},profile});
 const base={source:'UAT_SIMULATED',correlationId,attempt};
 if(profile.scenario==='INVALID')
  return {...base,kind:'INVALID',retryable:false,errorCode:'UAT_SIMULATED_INVALID_SCENARIO'};
 if(profile.scenario==='FAILURE')
  return {...base,kind:'FAILURE',retryable:true,errorCode:'UAT_SIMULATED_DELIVERY_FAILURE'};

 const availableAtMs=assignedAtMs+(profile.scenario==='DELAYED'?profile.delay_ms:0);
 if(profile.scenario==='DELAYED'&&requestedAtMs<availableAtMs)
  return {...base,kind:'DELAYED',retryable:true,availableAt:new Date(availableAtMs).toISOString()};

 const event=Object.freeze({
  externalEventId,eventType:'TARE_RECORDED',tripId,truckId,assignmentRevision,profileRevision,
  weightT,occurredAt:new Date(availableAtMs).toISOString(),source:'UAT_SIMULATED',verified:false
 });
 const deliveries=profile.scenario==='DUPLICATE'?[event,{...event}]:[event];
 return {...base,kind:'EVENT',event,deliveries};
}
