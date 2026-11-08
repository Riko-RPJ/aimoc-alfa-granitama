export const rows=value=>Array.isArray(value)?value:[];
export const done=trip=>['returned','cancelled'].includes(trip?.status);
export const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:0;
export const bySerial=(a,b)=>(a.sequence??0)-(b.sequence??0)||String(a.code).localeCompare(String(b.code));
export function frameAt(frames,time){let index=0;for(let i=0;i<frames.length;i++){if(Number(frames[i].at)>time)break;index=i;}return {frame:frames[index],index};}
export function truckTrips(state,id){return rows(state?.trips).filter(trip=>trip.truckId===id).sort(bySerial);}
export function currentTrip(state,id){const trips=truckTrips(state,id);return trips.find(trip=>!done(trip))||trips.at(-1);}
export function replayTrucks(fixture){const final=rows(fixture?.frames).at(-1)?.state||{},ids=new Set(rows(final.trips).map(trip=>trip.truckId).filter(Boolean));return rows(final.trucks).filter(truck=>ids.has(truck.id));}
export function sourcePoint(state,crusherId){const index=Math.max(0,rows(state?.crushers).findIndex(crusher=>crusher.id===crusherId));return {x:265,y:index%2?280:108};}
const parking=index=>({x:130+index*76,y:450});
function eventPoint(state,event,index){
 const trip=rows(state.trips).find(trip=>trip.id===(event.tripId||event.payload?.tripId));if(!trip)return null;
 const purpose=event.purpose||event.payload?.purpose,laneId=event.laneId||event.payload?.laneId,action=event.action;
 let point,stage;
 if(purpose==='ENTRY'){point={x:450,y:laneId==='lane-3'?370:142};stage=laneId==='lane-3'?'repeat':'entry';}
 else if(purpose==='EXIT'){point={x:450,y:242};stage='exit';}
 else if(purpose==='RETURN'){point={x:450,y:370};stage='return';}
 else if(action==='trip.loading'){point=sourcePoint(state,trip.crusherId);stage='loading';}
 else if(action==='trip.arrive'){point={x:812,y:242};stage='arrive';}
 else if(action==='trip.receive'){point={x:846,y:242};stage='receive';}
 else return null;
 return {...point,stage,tripId:trip.id,crusherId:trip.crusherId,truckId:trip.truckId,offset:(index-1.5)*25};
}
export function buildTracks(fixture){
 const frames=rows(fixture?.frames),trucks=replayTrucks(fixture),duration=Number(fixture?.duration)||Number(frames.at(-1)?.at)||1;
 return trucks.map((truck,index)=>{
  const allocation=frames.find(frame=>frame.event?.action==='quarry.dispatch.plan'),points=[{...parking(index),at:0,stage:'parking',offset:0}];
  if(Number(allocation?.at)>0)points.push({...parking(index),at:Number(allocation.at),stage:'parking',offset:0});
  for(const frame of frames){for(const event of rows(frame.events).length?frame.events:[frame.event||{}]){const point=eventPoint(frame.state||{},event,index);if(point?.truckId===truck.id)points.push({...point,at:Number(frame.at)});}}
  const last=points.at(-1);if(last.stage==='return')points.push({...parking(index),at:Math.min(duration,last.at+4),stage:'idle',offset:0});
  return {truck,points};
 });
}
function routeBetween(from,to){
 if(['arrive','receive'].includes(to.stage))return [from,to];
 if(to.stage==='return')return [from,{x:812,y:370},to];
 if(to.stage==='idle')return [from,{x:355,y:450},to];
 if(to.stage==='loading')return [from,{x:300,y:from.y},{x:275,y:to.y},to];
 if(to.stage==='exit')return [from,{x:275,y:from.y},{x:315,y:242},to];
 if(to.stage==='entry')return [from,{x:355,y:450},{x:355,y:142},to];
 if(to.stage==='repeat')return [from,to];
 return [from,to];
}
export function positionOnTrack(track,time){
 const points=track.points;let from=points[0],to=from;
 for(let i=1;i<points.length;i++){if(points[i].at<=time){from=points[i];to=from;}else{to=points[i];break;}}
 const fraction=to.at===from.at?1:Math.max(0,Math.min(1,(time-from.at)/(to.at-from.at))),path=routeBetween(from,to),lengths=path.slice(1).map((point,i)=>Math.hypot(point.x-path[i].x,point.y-path[i].y)),total=lengths.reduce((sum,value)=>sum+value,0);let remaining=total*fraction;
 for(let i=0;i<lengths.length;i++){if(remaining<=lengths[i]||i===lengths.length-1){const a=path[i],b=path[i+1],f=lengths[i]?remaining/lengths[i]:1;return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f+(to.offset||0),angle:Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI};}remaining-=lengths[i];}
 return {x:from.x,y:from.y+(from.offset||0),angle:0};
}
export function livePosition(state,trip,index){
 const source=sourcePoint(state,trip?.crusherId),offset=(index-1.5)*25;
 const anchors={ready_to_load:{x:450,y:142},loading:source,weighed:{x:450,y:242},in_transit:{x:650,y:242},arrived:{x:812,y:242},unloaded:{x:846,y:242},returning:{x:650,y:370}};
 const point=anchors[trip?.status]||parking(index);return {...point,y:point.y+offset,angle:trip?.status==='returning'?180:0};
}
export function replayCounters(state,skuId){
 const trips=rows(state?.trips),piles=rows(state?.stockpiles).filter(pile=>!skuId||pile.skuId===skuId),vessels=rows(state?.vessels),truckIds=[...new Set(trips.map(trip=>trip.truckId).filter(Boolean))];
 return {physicalM3:piles.reduce((sum,pile)=>sum+finite(pile.onHandM3),0),reservedM3:piles.reduce((sum,pile)=>sum+finite(pile.reservedM3),0),loadedT:vessels.reduce((sum,vessel)=>sum+finite(vessel.loadedT),0),vesselReservedT:vessels.reduce((sum,vessel)=>sum+finite(vessel.reservedT),0),returned:trips.filter(trip=>trip.status==='returned').length,idle:truckIds.filter(id=>truckTrips(state,id).every(done)).length};
}
