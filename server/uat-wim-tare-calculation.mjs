const SCALE=1_000_000n;

const fail=(code,message)=>{throw Object.assign(new Error(message),{status:422,code});};

function scaled(value,{field,allowZero=false,missingCode,invalidCode}){
  if(value===undefined||value===null||value==='')fail(missingCode,`${field} is required`);
  if(typeof value!=='string'||!/^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.test(value))
    fail(invalidCode,`${field} must be a canonical decimal string with at most 6 decimals`);
  const [whole,fraction='']=value.split('.');
  const result=BigInt(whole)*SCALE+BigInt(fraction.padEnd(6,'0'));
  if(result<0n||(!allowZero&&result===0n))
    fail(invalidCode,`${field} must be ${allowZero?'non-negative':'positive'}`);
  return result;
}

const decimal=value=>`${value/SCALE}.${(value%SCALE).toString().padStart(6,'0')}`;

export function calculateLoadingCapacity({approvedGvwT,tareT,approvedPayloadT,remainingPlannedT}={}){
  const approvedGvw=scaled(approvedGvwT,{field:'approvedGvwT',missingCode:'UAT_CAPACITY_MISSING',invalidCode:'UAT_CAPACITY_INVALID'});
  const tare=scaled(tareT,{field:'tareT',missingCode:'UAT_TARE_MISSING',invalidCode:'UAT_TARE_INVALID'});
  const approvedPayload=scaled(approvedPayloadT,{field:'approvedPayloadT',missingCode:'UAT_CAPACITY_MISSING',invalidCode:'UAT_CAPACITY_INVALID'});
  const remainingPlanned=scaled(remainingPlannedT,{field:'remainingPlannedT',allowZero:true,missingCode:'UAT_CAPACITY_MISSING',invalidCode:'UAT_CAPACITY_INVALID'});
  if(tare>=approvedGvw)fail('UAT_TARE_INVALID','tareT must be less than approvedGvwT');

  const gvwAvailable=approvedGvw-tare;
  const limits=[['GVW',gvwAvailable],['PAYLOAD',approvedPayload],['REMAINING_PLANNED',remainingPlanned]];
  const [limitedBy,loadingLimit]=limits.reduce((lowest,candidate)=>candidate[1]<lowest[1]?candidate:lowest);
  return {gvwAvailableT:decimal(gvwAvailable),loadingLimitT:decimal(loadingLimit),limitedBy};
}
