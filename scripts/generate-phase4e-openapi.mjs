import {writeFile,mkdir} from 'node:fs/promises';
import {API_ROUTE_CONTRACTS,FINAL_API_GAPS} from '../src/contracts/api-v1-candidate.js';

const string={type:'string'};
const id={type:'string',minLength:1,maxLength:120};
const tonnes={type:'string',pattern:'^(0|[1-9][0-9]{0,9})(\\.[0-9]{1,6})?$',description:'Exact tonnes as decimal string, not m3'};
const iso={type:'string',format:'date-time'};
const nullable=type=>({anyOf:[type,{type:'null'}]});
const schemas={
 Envelope:{type:'object',required:['schema_version','resource','source','data_status','as_of','data'],
  properties:{schema_version:{const:'1.0'},resource:string,source:{enum:['V1_STAGING','LEGACY_SNAPSHOT','NOT_INTEGRATED','LOCAL_UAT']},
   data_status:{enum:['READY','EMPTY','STALE','NOT_INTEGRATED']},as_of:nullable(iso),
   data:nullable({type:'object',additionalProperties:true})}},
 Error:{type:'object',required:['error','message'],properties:{error:string,message:string}},
 Trip:{type:'object',required:['trip_id','dispatch_id','assignment_id','driver_id','truck_id','status','source_stockpile_id','sku_id','inventory','crusher_destination','contract_integrity','tare_t','gross_t','actual_net_t','unloaded_verified_at','returned_available_at'],
  properties:{trip_id:id,dispatch_id:id,truck_id:id,status:string,
   assignment_id:nullable(id),driver_id:id,source_stockpile_id:id,sku_id:id,
   inventory:nullable({type:'object',additionalProperties:true}),
   crusher_destination:nullable({type:'object',additionalProperties:true}),
   contract_integrity:{type:'object',additionalProperties:true},
   tare_t:nullable(tonnes),gross_t:nullable(tonnes),actual_net_t:nullable(tonnes),
   unloaded_verified_at:nullable(iso),returned_available_at:nullable(iso)}},
 WeighbridgeEvent:{type:'object',required:['source_system','external_event_id','event_type','trip_id','truck_id','weighbridge_id','occurred_at'],
  properties:{source_system:id,external_event_id:id,event_type:{enum:['QR_SCANNED','TARE_RECORDED','GROSS_RECORDED']},
   trip_id:id,truck_id:id,weighbridge_id:id,occurred_at:iso,weight_t:tonnes},
  description:'QR is identity only and MUST omit weight_t. TARE/GROSS must include positive or zero decimal weight as applicable.'},
 InventoryItem:{type:'object',required:['stockpile_id','sku_id','on_hand_t','reserved_t','available_t','source','as_of'],
  properties:{stockpile_id:id,sku_id:id,on_hand_t:nullable(tonnes),reserved_t:nullable(tonnes),
   available_t:nullable(tonnes),source:string,as_of:nullable(iso)},
  description:'Target DTO only; legacy projection currently provides m3 separately and null actual tonnes.'},
 DriverActiveTrip:{type:'object',required:['data_status','trip'],
  properties:{data_status:{enum:['READY','EMPTY','NOT_INTEGRATED']},trip:nullable({type:'object',additionalProperties:true})}}
};
const tripAssignment={type:'object',additionalProperties:false,
 required:['trip_id','assignment_id','sequence_no','driver_id','truck_id','planned_quantity_t'],
 properties:{trip_id:id,assignment_id:id,sequence_no:{type:'integer',minimum:1},
  driver_id:id,truck_id:id,planned_quantity_t:tonnes}};
const newDispatch={type:'object',additionalProperties:false,
 required:['dispatch_id','mode','source_stockpile_id','destination_location_id','sku_id',
  'planned_quantity_t','crusher_id','loading_point_id','trips'],
 properties:{dispatch_id:id,mode:{enum:['LAND','MARINE']},source_stockpile_id:id,
  destination_location_id:id,sku_id:id,planned_quantity_t:tonnes,
  crusher_id:id,loading_point_id:id,voyage_id:nullable(id),
  jetty_window_id:nullable(id),
  trips:{type:'array',minItems:1,maxItems:50,items:tripAssignment}}};
const commands={
 'dispatch-create':newDispatch,
 'accept-pickup':{type:'object',additionalProperties:false,properties:{}},
 'assign-loading-point':{type:'object',required:['crusher_id','loading_point_id'],additionalProperties:false,
  properties:{crusher_id:id,loading_point_id:id}},
 'assign-driver':{type:'object',required:['assignment_id','driver_id'],additionalProperties:false,
  properties:{assignment_id:id,driver_id:id}},
 reserve:{type:'object',additionalProperties:false,properties:{}},
 start:{type:'object',additionalProperties:false,properties:{}},
 hold:{type:'object',required:['reason'],additionalProperties:false,properties:{reason:{type:'string',minLength:8,maxLength:300}}},
 'resolve-hold':{type:'object',required:['resolution_note'],additionalProperties:false,properties:{resolution_note:{type:'string',minLength:8,maxLength:300}}},
 loading:{type:'object',additionalProperties:false,properties:{}},
 depart:{type:'object',additionalProperties:false,properties:{}},
 arrive:{type:'object',additionalProperties:false,properties:{}},
 receive:{type:'object',required:['received_t','external_receipt_id'],additionalProperties:false,
  properties:{received_t:tonnes,external_receipt_id:id}},
 'finalize-unload':{type:'object',additionalProperties:false,properties:{}},
 'driver-checklist':{type:'object',required:['item_id','status'],additionalProperties:false,
  properties:{item_id:id,status:{enum:['DONE','ISSUE']},note:nullable({type:'string',maxLength:500})}},
 'driver-return':{type:'object',additionalProperties:false,properties:{}},
 'return-evidence':{type:'object',required:['source_event_id','vehicle_ready'],additionalProperties:false,
  properties:{source_event_id:id,vehicle_ready:{type:'boolean'}}},
 'return-complete':{type:'object',additionalProperties:false,properties:{}}
};
const desc={
 'inventory-read':'Legacy inventory snapshot projected with exact m3 provenance; actual tonnage is null until verified.',
 'overview-read':'Compatibility projection; unverified KPIs must stay null.',
 'dispatch-read':'Staging unified execution dispatch projection or legacy compatibility on normal app; production cutover not accepted.',
 'dispatch-create':'Atomic staging dispatch, trips, Driver+truck assignments and crusher reference; reservation remains separate.',
 'stockpile-pickups':'Scoped pickup list. TARE_CONFIRMED mandatory before pickup acceptance.',
 'accept-pickup':'Stockpile authorizes loading after a signed independently ingested QR/TARE sequence. No Driver self-approval.',
 'driver-active':'Strict identity-scoped Driver assignment; Phase4E adds independent binding verification.',
 'trip-detail':'Staging normalized transaction read, role/driver assignment scoped.',
 weighbridge:'Signed M2M event only. Vendor protocol readiness, authenticated source and ordering required.',
 reserve:'Reserve actual inventory; Phase4E requires approved opening stock and journal match.',
 'return-evidence':'Independent return evidence; Driver self-report is insufficient.'
};
const paths={};
for(const r of API_ROUTE_CONTRACTS){
 const kind=r.method.toLowerCase();
 const m={
  operationId:r.id.replaceAll('-','_'),tags:[r.family],
  summary:r.id.replaceAll('-',' '),description:desc[r.id]||'Candidate route. Not production activated.',
  'x-aimoc-roles':r.roles,
  'x-aimoc-implementation':r.method==='GET'&&['session','inventory-read','overview-read'].includes(r.id)?'legacy-compatibility':'isolated-staging',
  responses:{'200':{description:'Envelope with explicit provenance and data status',content:{'application/json':{schema:{$ref:'#/components/schemas/Envelope'}}}},
   '401':{description:'Unauthenticated'},'403':{description:'Role/scope denied'},
   '409':{description:'State conflict; no assumed success'},'501':{description:'Unavailable in normal application'}},
  security:r.roles.includes('m2m')?[{WeighbridgeSignature:[]}]:[{SessionCookie:[]}]
 };
 if(r.roles.includes('m2m')){
  m.parameters=[{in:'header',name:'X-AIMOC-Source',required:true,schema:string},
   {in:'header',name:'X-AIMOC-Timestamp',required:true,schema:iso},
   {in:'header',name:'X-AIMOC-Signature',required:true,schema:string}];
  m.requestBody={required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/WeighbridgeEvent'}}}};
  m.responses['202']=m.responses['200'];delete m.responses['200'];
 }else if(kind==='post'){
  m.parameters=[{in:'header',name:'Idempotency-Key',required:true,schema:{type:'string',minLength:6}},
   {in:'header',name:'X-CSRF-Token',required:true,schema:string}];
  m.requestBody={required:true,content:{'application/json':{schema:commands[r.id]||{type:'object'}}}};
 }
 for(const param of [...r.path.matchAll(/\{([^}]+)\}/g)]){
  m.parameters??=[];
  m.parameters.push({in:'path',name:param[1],required:true,schema:id});
 }
 (paths[r.path]??={})[kind]=m;
}
const document={
 openapi:'3.1.0',
 info:{title:'AIMOC API v1 — Candidate',version:'1.0-candidate',
  description:'NOT PRODUCTION ACCEPTED. This document describes staging + legacy compatibility routes. It does not approve real vendor, inventory evidence or final DTO parity.'},
 'x-aimoc-production-accepted':false,'x-aimoc-frontend-migration-allowed':false,
 'x-aimoc-open-gaps':FINAL_API_GAPS,
 paths,
 components:{securitySchemes:{
  SessionCookie:{type:'apiKey',in:'cookie',name:'aimoc_session'},
  WeighbridgeSignature:{type:'apiKey',in:'header',name:'X-AIMOC-Signature',
   description:'HMAC-SHA256 over timestamp+newline+unmodified body, bound to managed source ID; not a stand-alone device identity'}},
  schemas}
};
await mkdir('qa/phase4e',{recursive:true});
await writeFile('qa/phase4e/AIMOC_OpenAPI_v1_candidate.json',JSON.stringify(document,null,2)+'\n');
console.log('Generated paths:',Object.keys(paths).length,'operations:',API_ROUTE_CONTRACTS.length,'unresolved:',FINAL_API_GAPS.length);
