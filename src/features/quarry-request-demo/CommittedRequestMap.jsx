import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useLanguage} from '../../i18n.js';
import {QuarryFlowMap} from '../quarry-flow-demo/QuarryFlowDemo.jsx';
import {positionOnTrack,sourcePoint} from '../quarry-flow-demo/helpers.mjs';
import {rows} from './request-demo-view.mjs';

const gates=trip=>rows(trip?.quarry?.gateEvents||trip?.quarryGateEvents);
const closed=trip=>['returned','cancelled'].includes(trip.status);
export const phaseDuration=speed=>3500/Math.max(.5,Math.min(4,Number(speed)||1));
function targets(state){
 const ids=[...new Set(rows(state.trips).map(trip=>trip.truckId).filter(Boolean))];
 return ids.map((id,index)=>{const serial=rows(state.trips).filter(trip=>trip.truckId===id).sort((a,b)=>(a.sequence||0)-(b.sequence||0)),open=serial.find(trip=>!closed(trip)),trip=open||serial.at(-1),previous=serial.filter(item=>item.status==='returned').at(-1),gate=gates(trip).at(-1),spread={x:Math.floor(index/5)*30,y:ids.length<=5?(index-(ids.length-1)/2)*22:(index%5-2)*24};let stage='parking',point={x:130+(index%5)*70,y:450+Math.floor(index/5)*16};
  if(['start_pending','ready_to_load'].includes(trip.status)){stage=gate?.laneId==='lane-3'?'repeat':'entry';point={x:450,y:stage==='repeat'?370:142};}
  else if(trip.status==='loading'){stage='loading';point=sourcePoint(state,trip.crusherId);}
  else if(['weighed','in_transit'].includes(trip.status)){stage='exit';point={x:450,y:242};}
  else if(trip.status==='arrived'){stage='arrive';point={x:812,y:242};}
  else if(trip.status==='unloaded'){stage='receive';point={x:846,y:242};}
  else if(trip.status==='returning'||trip.status==='returned'||trip.status==='queued'&&previous){stage='return';point={x:450,y:370};}
  if(stage!=='parking')point={x:point.x+spread.x,y:point.y+spread.y};
  const parking={x:130+(index%5)*70,y:450+Math.floor(index/5)*16};
  return {truck:rows(state.trucks).find(item=>item.id===id)||{id,code:id},point:{...point,stage,offset:0},parking,finished:!open,signature:[trip.id,trip.status,gate?.id,trip.receivedAt,previous?.id,previous?.returnedAt].join(':')};
 });
}
/** Only accepted state changes choose destinations. Interpolation never issues commands or changes counts. */
export function CommittedRequestMap({state,requestId,speed=1,paused=false}){
 const language=useLanguage(),L=(id,en)=>language==='en'?en:id,items=targets(state),signature=items.map(item=>`${item.truck.id}:${item.signature}`).join('|'),duration=phaseDuration(speed)/1000;
 const positions=useRef(new Map()),previousRequest=useRef(requestId),first=useRef(true),motion=useRef(null),[animation,setAnimation]=useState({tracks:[],time:0,playing:false});
 useEffect(()=>{
  if(previousRequest.current!==requestId){positions.current=new Map();previousRequest.current=requestId;first.current=true;motion.current=null;}
  let raf,last=performance.now(),rendered=last;const initial=first.current,key=`${requestId}|${signature}`,reuse=motion.current?.key===key;first.current=false;
  const ratio=reuse?duration/motion.current.duration:1;
  const tracks=reuse?motion.current.tracks.map(track=>({...track,points:track.points.map(point=>({...point,at:point.at*ratio}))})):items.map(item=>{const from=positions.current.get(item.truck.id)||item.point,target={...item.point,at:duration};const points=[{...from,at:0,offset:0},target];if(item.finished&&item.point.stage==='return')points.splice(1,1,{...target,at:duration*.75},{...item.parking,stage:'idle',offset:0,at:duration});return {truck:item.truck,points};});
  let elapsed=reuse?motion.current.elapsed*ratio:0;motion.current={key,tracks,elapsed,duration};
  if(initial){for(const track of tracks){const point=positionOnTrack(track,duration);positions.current.set(track.truck.id,{...point,stage:track.points.at(-1).stage});}motion.current.elapsed=duration;setAnimation({tracks,time:duration,playing:false});return;}
  setAnimation({tracks,time:elapsed,playing:!paused&&elapsed<duration});if(paused||elapsed>=duration)return;
  const tick=now=>{elapsed=Math.min(duration,elapsed+(now-last)/1000);last=now;motion.current.elapsed=elapsed;for(const track of tracks){const point=positionOnTrack(track,elapsed);positions.current.set(track.truck.id,{...point,stage:track.points.at(-1).stage});}if(now-rendered>=30||elapsed===duration){setAnimation({tracks,time:elapsed,playing:elapsed<duration});rendered=now;}if(elapsed<duration)raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);
 },[signature,requestId,duration,paused]);
 const mapState=useMemo(()=>({...state,trucks:rows(state.trucks).filter(truck=>rows(state.trips).some(trip=>trip.truckId===truck.id))}),[state]);
 return <div className="qrd-committed-map" data-testid="request-demo-committed-map" data-animation-playing={animation.playing?'true':'false'} data-phase-ms={phaseDuration(speed)}><QuarryFlowMap state={mapState} progress={{tracks:animation.tracks,time:animation.time,playing:animation.playing,finalState:mapState}}/><p>{L('Gerak skematis mengikuti tahap yang sudah tersimpan. Angka penerimaan dan stok tetap berasal dari server.','Schematic motion follows stages already saved. Receipt and stock figures continue to come from the server.')}</p></div>;
}
