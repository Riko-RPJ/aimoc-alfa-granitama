export const QUARRY_WORKFLOW='QUARRY_CILEGON';
export const rows=value=>Array.isArray(value)?value:[];
export const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
export const isQuarry=value=>value?.workflow===QUARRY_WORKFLOW||value?.quarryWorkflow===QUARRY_WORKFLOW;
export const finished=value=>['returned','cancelled'].includes(value?.status);
export const models=[{id:'WIM_WIM',label:'WIM + WIM',modes:['WIM','WIM']},{id:'STATIC_WIM',label:'Static + WIM',modes:['STATIC','WIM']},{id:'STATIC_STATIC',label:'Static + Static',modes:['STATIC','STATIC']}];
export function assignmentValue(trip){
 if(typeof trip?.quarry?.dispatchPass?.value==='string')return trip.quarry.dispatchPass.value;
 if(typeof trip?.qr?.value==='string')return trip.qr.value;
 if(!['requestId','dispatchId','id','truckId'].every(key=>typeof trip?.[key]==='string'&&trip[key]))return '';
 return JSON.stringify({v:1,type:'AIMOC_ASSIGNMENT_REFERENCE',requestId:trip.requestId,dispatchId:trip.dispatchId,tripId:trip.id,truckId:trip.truckId});
}
export function availableGateLanes(config,trip,purpose){
 const direction=purpose==='EXIT'?'OUT':'IN';
 return rows(config?.lanes).filter(lane=>lane.active!==false&&['BIDIRECTIONAL',direction].includes(lane.direction)&&(purpose==='RETURN'||lane.mode!=='QR_ONLY'||purpose==='ENTRY'&&trip?.quarry?.canReuseTare===true));
}
export function quarryInventory(stockpiles,products){
 return rows(products).map(product=>{
  const bins=rows(stockpiles).filter(bin=>bin.skuId===product.id),known=bins.every(bin=>number(bin.onHandM3)!==null&&number(bin.reservedM3)!==null);
  const physical=known?bins.reduce((sum,bin)=>sum+bin.onHandM3,0):null,reserved=known?bins.reduce((sum,bin)=>sum+bin.reservedM3,0):null;
  return {product,bins:bins.length,physical,reserved,available:known?physical-reserved:null};
 });
}
