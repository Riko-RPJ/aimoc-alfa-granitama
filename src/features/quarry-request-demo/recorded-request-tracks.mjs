import {sourcePoint} from '../quarry-flow-demo/helpers.mjs';
import {rows} from './request-demo-view.mjs';
export function recordedRequestTracks(state){
 const ids=[...new Set(rows(state.trips).map(trip=>trip.truckId).filter(Boolean))],phaseSeconds=3.5;let missingRecords=0,maxRounds=0;
 const tracks=ids.map((id,index)=>{const truck=rows(state.trucks).find(item=>item.id===id)||{id,code:id},serial=rows(state.trips).filter(trip=>trip.truckId===id&&trip.status==='returned').sort((a,b)=>(a.sequence||0)-(b.sequence||0)),parking={x:130+(index%5)*70,y:450+Math.floor(index/5)*16},offset={x:Math.floor(index/5)*30,y:ids.length<=5?(index-(ids.length-1)/2)*22:(index%5-2)*24},points=[{...parking,at:0,stage:'parking',offset:0}];maxRounds=Math.max(maxRounds,serial.length);
  serial.forEach((trip,round)=>{const gates=rows(trip.quarry?.gateEvents||trip.quarryGateEvents),entry=gates.find(item=>item.purpose==='ENTRY'),exit=gates.find(item=>item.purpose==='EXIT'),back=gates.find(item=>item.purpose==='RETURN');const stages=[
   [Boolean(entry),entry?.laneId==='lane-3'?'repeat':'entry',{x:450,y:entry?.laneId==='lane-3'?370:142},'ENTRY',entry?.laneId],
   [Boolean(trip.loadingAt),'loading',sourcePoint(state,trip.crusherId),'trip.loading'],
   [Boolean(exit),'exit',{x:450,y:242},'EXIT',exit?.laneId],
   [Boolean(trip.arrivedAt),'arrive',{x:812,y:242},'trip.arrive'],
   [Boolean(trip.receivedAt&&trip.receiptCode),'receive',{x:846,y:242},'trip.receive'],
   [Boolean(back),'return',{x:450,y:370},'RETURN',back?.laneId]
  ];stages.forEach(([accepted,stage,point,action,laneId],phase)=>{if(!accepted){missingRecords++;return;}points.push({...point,x:point.x+offset.x,y:point.y+offset.y,at:(round*6+phase+1)*phaseSeconds,stage,offset:0,tripId:trip.id,tripCode:trip.code,action,laneId,receiptCode:trip.receiptCode||null});});});
  points.push({...parking,at:(serial.length*6+1)*phaseSeconds,stage:'idle',offset:0});return {truck,points};
 });
 return {tracks,duration:(maxRounds*6+1)*phaseSeconds,missingRecords};
}
