const TIME_ZONE='Asia/Jakarta',WIB_OFFSET_MS=7*60*60*1000,DAY_MS=24*60*60*1000;
const OPEN_STATUSES=new Set(['queued','start_pending','ready_to_load','loading','weighed','in_transit','arrived','unloaded','returning','waiting_truck','waiting_driver','waiting_assignment','awaiting_assignment','unassigned']);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const present=value=>value!==undefined&&value!==null;
const fail=(code,status)=>{throw Object.assign(new Error(code),{code,status,name:'DomainError'});};

// Persisted event timestamps must be explicit instants; never use host-local date parsing.
function timestamp(value){
 if(typeof value!=='string')return null;
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!match)return null;
 const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number);
 const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)return null;
 const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;
}

function period(now){
 const value=typeof now==='function'?now():now===undefined?new Date():now;
 const instant=value instanceof Date?value.getTime():typeof value==='string'?timestamp(value):typeof value==='number'?value:NaN;
 if(!Number.isFinite(instant))fail('DRIVER_DAILY_SUMMARY_TIME_INVALID',500);
 const shifted=new Date(instant+WIB_OFFSET_MS);if(!Number.isFinite(shifted.getTime()))fail('DRIVER_DAILY_SUMMARY_TIME_INVALID',500);
 const localDate=shifted.toISOString().slice(0,10);
 const start=Date.parse(localDate+'T00:00:00.000Z')-WIB_OFFSET_MS;
 return {localDate,start,end:start+DAY_MS};
}

function openMembership(trip,start,end,includeCarryover){
 const fields=['assignedAt','startedAt'].filter(key=>present(trip[key]));
 const timestamps=fields.length?fields.map(key=>timestamp(trip[key])):[timestamp(trip.createdAt)];
 if(timestamps.some(value=>value!==null&&(includeCarryover?value<end:value>=start&&value<end)))return true;
 if(timestamps.some(value=>value===null))return null;
 return false;
}

/** Read-only counts for this Driver; callers must not accept now/policy from request bodies. */
export function summarizeDriverDailyTrips(state,actor,{now,includeCarryover=false}={}){
 if(actor?.role!=='driver'||!validId(actor.id)||actor.active===false)fail('FORBIDDEN',403);
 if(!Array.isArray(state?.trips)||typeof includeCarryover!=='boolean')fail('DRIVER_DAILY_SUMMARY_STATE_INVALID',409);
 const {localDate,start,end}=period(now);
 const scoped=state.trips.filter(trip=>trip?.source==='INTEGRATED_DEMO'&&trip.assignedDriverUserId===actor.id);
 const idCounts=new Map();for(const trip of scoped)idCounts.set(trip.id,(idCounts.get(trip.id)||0)+1);
 let unfinished=0,completed=0,unknownUnfinished=0,unknownCompleted=0;
 for(const trip of scoped){
  const status=typeof trip.status==='string'?trip.status.toLowerCase():'';
  if(status==='cancelled')continue;
  if(!validId(trip.id)||idCounts.get(trip.id)!==1){unknownUnfinished++;unknownCompleted++;continue;}
  if(status==='returned'||status==='completed'){
   // 'completed' is not the current trip FSM terminal; require the same return-verifier marker.
   const verified=status==='returned'||validId(trip.returnVerifiedBy);
   const completedAt=verified?timestamp(status==='returned'?trip.returnedAt:trip.completedAt):null;
   if(completedAt===null)unknownCompleted++;
   else if(completedAt>=start&&completedAt<end)completed++;
  }else if(OPEN_STATUSES.has(status)){
   const membership=openMembership(trip,start,end,includeCarryover);
   if(membership===true)unfinished++;else if(membership===null)unknownUnfinished++;
  }else{unknownUnfinished++;unknownCompleted++;}
 }
 const availability={unfinishedTrips:unknownUnfinished===0,completedTrips:unknownCompleted===0};
 return {localDate,timeZone:TIME_ZONE,periodStart:new Date(start).toISOString(),periodEnd:new Date(end).toISOString(),unfinishedTrips:availability.unfinishedTrips?unfinished:null,completedTrips:availability.completedTrips?completed:null,status:availability.unfinishedTrips&&availability.completedTrips?'READY':'PARTIAL',availability,includeCarryover,
  definition:{source:'INTEGRATED_DEMO',scope:'ASSIGNED_DRIVER_ONLY',unfinished:includeCarryover?'OPEN_ASSIGNED_OR_STARTED_BEFORE_END':'ASSIGNED_OR_STARTED_TODAY',completed:'VERIFIED_RETURN_OR_COMPLETED_TODAY',interval:'START_INCLUSIVE_END_EXCLUSIVE',legacyFallback:'CREATED_AT_IF_NO_ASSIGNMENT_OR_START_TIMESTAMP',cancelled:'EXCLUDED',unloaded:'UNFINISHED_UNTIL_RETURN_VERIFIED'},
  unclassifiedTrips:{unfinished:unknownUnfinished,completed:unknownCompleted}};
}
