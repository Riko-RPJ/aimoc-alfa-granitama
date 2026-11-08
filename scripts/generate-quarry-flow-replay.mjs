import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';
import {assertSerialDispatchClaims} from '../server/automatic-dispatch.mjs';
import {quarryDispatchPass,quarryHasJettyReceipt} from '../server/quarry-cilegon-domain.mjs';

/** A disposable operation document only. No database, HTTP writes, or accounts. */
export function generateQuarryFlowReplay(){
 const state=createSeed(),admin={id:'replay-admin',role:'admin',username:'Synthetic replay admin'};
 const drivers=Array.from({length:4},(_,index)=>({id:`replay-driver-${index+1}`,username:`replay-driver-${index+1}`,displayName:`Demo Driver ${index+1}`,role:'driver',active:true}));
 const options={drivers},frames=[];
 state.products=state.products.filter(product=>product.id==='split-12');
 state.stockpiles=state.stockpiles.filter(stock=>stock.skuId==='split-12').map(stock=>({...stock,onHandM3:1000,reservedM3:0}));
 state.trucks=state.trucks.slice(0,4).map(truck=>({...truck,bedM3:30,payloadLimitT:45,cycleMinutes:30}));
 state.jetties=state.jetties.filter(jetty=>jetty.id==='jetty-1');
 state.vessels=state.vessels.filter(vessel=>vessel.id==='vessel-1');
 const act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);
 act('quarry.config.save',{model:'STATIC_WIM',enabled:true,defaultWorkflow:'QUARRY_CILEGON'});
 let at=0,eventNumber=0;
 const capture=(chapter,title,description,event=null)=>{
  assertSerialDispatchClaims(state);
  const projected=integratedView(state,admin,options);
  frames.push({at,chapter,title:{id:title[0],en:title[1]},description:{id:description[0],en:description[1]},event,state:projected});
 };
 capture('setup',['Satu permintaan, dua crusher','One request, two crushers'],['Empat truk tersedia. Masing-masing crusher menyediakan SKU SP-12 untuk jetty dan kapal yang sama.','Four trucks are available. Both crushers supply SKU SP-12 to the same jetty and vessel.']);
 at=4;
 const requestId=act('quarry.request.create',{transferMode:'MARINE',destinationLocationId:state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:360,unit:'t'}]}).requestId;
 capture('request',['Permintaan 360 ton','360 tonne request'],['Permintaan menetapkan SKU, densitas, jetty dan kapal tujuan sebelum stok atau armada dialokasikan.','The request establishes the SKU, density, jetty and vessel before stock or fleet allocation.'],{action:'quarry.request.create',requestId});
 at=8;act('quarry.dispatch.plan',{requestId});
 const dispatch=state.dispatches.find(row=>row.requestId===requestId),trips=()=>state.trips.filter(trip=>trip.dispatchId===dispatch.id).sort((a,b)=>a.sequence-b.sequence);
 assert.equal(trips().length,8);assert.equal(dispatch.allocations.length,2);
 assert.equal(new Set(trips().map(trip=>trip.truckId)).size,4);
 const queues=state.trucks.map(truck=>trips().filter(trip=>trip.truckId===truck.id));
 assert.ok(queues.every(queue=>queue.length===2));
 assert.deepEqual(queues.map(queue=>queue[0].crusherId),['crusher-1','crusher-2','crusher-1','crusher-2']);
 capture('dispatch',['Empat truk, delapan ritase','Four trucks, eight trips'],['Satu dispatch membagi 180 ton per crusher. Empat truk bekerja bersamaan, dengan dua ritase berurutan per truk.','One dispatch allocates 180 tonnes per crusher. Four trucks work concurrently, with two sequential trips per truck.'],{action:'quarry.dispatch.plan',requestId,dispatchId:dispatch.id});
 const source=trip=>({id:`replay-stock-${trip.crusherId}`,role:'stock',crusherIds:[trip.crusherId]});
 const receiver={id:'replay-jetty',role:'jetty',jettyIds:['jetty-1']};
 const gate=(trip,purpose,round)=>{
  const laneId=purpose==='EXIT'?'lane-2':purpose==='RETURN'||round===1?'lane-3':'lane-1';
  const event={action:'quarry.gate.scan',tripId:trip.id,purpose,laneId,truckId:trip.truckId};
  act(event.action,{tripId:trip.id,truckId:trip.truckId,laneId,direction:purpose==='EXIT'?'OUT':'IN',purpose,qrValue:quarryDispatchPass(trip).value,externalEventId:`replay-gate-${++eventNumber}`,...(purpose==='EXIT'?{weightT:60}:purpose==='ENTRY'&&round===0?{weightT:15}:{})},source(trip));
  return event;
 };
 const copy={
  ENTRY:[['Masuk: QR dan tare','Entry: QR and tare'],['Petugas sumber mencatat QR dan tare. Truk lain dapat memasuki ritase pertamanya tanpa menunggu truk ini kembali.','The source operator records QR and tare. Other trucks can enter their first trips without waiting for this truck to return.']],
  REENTRY:[['Masuk ulang: tare dispatch','Repeat entry: dispatch tare'],['Ritase kedua dibuka setelah penerimaan jetty dan kembali terverifikasi. Lajur QR memakai ulang tare dispatch yang terbukti.','The second trip opens after the jetty receipt and verified return. The QR lane reuses the proven dispatch tare.']],
  loading:[['Pemuatan di crusher asal','Loading at the assigned crusher'],['Petugas sumber memulai pemuatan dari stockpile dispatch. Kuantitas rencana tetap 30 m³ atau 45 ton per ritase.','The source operator starts loading from the dispatch stockpile. Each trip retains its planned 30 m³ or 45 tonnes.']],
  EXIT:[['Gross, netto dan berangkat','Gross, net and departure'],['Gross 60 ton dikurangi tare 15 ton menghasilkan netto 45 ton. Stok fisik dan reservasi sumber berkurang tepat satu kali.','Gross 60 tonnes minus tare 15 tonnes gives net 45 tonnes. Physical source stock and its reservation decrease exactly once.']],
  arrive:[['Tiba di jetty tujuan','Arrival at the destination jetty'],['Operator jetty mencatat kedatangan. Muatan kapal belum bertambah sebelum penerimaan material dikonfirmasi.','The jetty operator records arrival. Vessel cargo does not increase before material receipt is confirmed.']],
  receive:[['Jetty menerima ke kapal','Jetty receives into the vessel'],['Operator jetty mengonfirmasi bongkar. Muatan kapal bertambah, reservasi kapal berkurang, dan bukti penerimaan tersimpan.','The jetty operator confirms unloading. Vessel cargo increases, its reservation decreases, and receipt evidence is retained.']],
  RETURN:[['Kembali: verifikasi QR','Return: QR verification'],['Petugas sumber memverifikasi truk kembali setelah bukti penerimaan jetty tersedia. Scan kembali tidak menciptakan penerimaan material.','The source operator verifies the returned truck after jetty receipt evidence exists. The return scan does not create a material receipt.']]
 };
 for(let round=0;round<2;round++){
  const current=queues.map(queue=>state.trips.find(trip=>trip.id===queue[round].id));
  for(const phase of ['ENTRY','loading','EXIT','arrive','receive','RETURN']){
   for(const original of current){
    const trip=state.trips.find(row=>row.id===original.id);at+=2;
    const event=['ENTRY','EXIT','RETURN'].includes(phase)?gate(trip,phase,round):{action:`trip.${phase}`,tripId:trip.id,truckId:trip.truckId};
    if(phase==='loading')act(event.action,{tripId:trip.id},source(trip));
    if(['arrive','receive'].includes(phase))act(event.action,{tripId:trip.id},receiver);
    const [title,description]=copy[phase==='ENTRY'&&round===1?'REENTRY':phase];
    capture(`${phase.toLowerCase()}-${round+1}`,title,description,{...event,round:round+1});
   }
   if(phase==='ENTRY')assert.ok(current.every(original=>state.trips.find(trip=>trip.id===original.id).status==='ready_to_load'));
   if(phase==='EXIT')assert.ok(current.every(original=>state.trips.find(trip=>trip.id===original.id).status==='in_transit'));
   if(phase==='receive')assert.ok(current.every(original=>quarryHasJettyReceipt(state,state.trips.find(trip=>trip.id===original.id))));
  }
 }
 const finalTrips=trips(),vessel=state.vessels[0];
 assert.ok(finalTrips.every(trip=>trip.status==='returned'&&quarryHasJettyReceipt(state,trip)));
 assert.equal(vessel.loadedT,360);assert.equal(vessel.reservedT,0);
 assert.equal(state.stockpiles.reduce((sum,stock)=>sum+stock.onHandM3,0),1760);
 assert.equal(state.stockpiles.reduce((sum,stock)=>sum+stock.reservedM3,0),0);
 assert.equal(state.inventoryLedger.length,16);assert.equal(state.erpOutbox.length,16);
 assert.ok(state.erpOutbox.every(row=>row.status==='awaiting_configuration'&&row.synthetic===true));
 at+=4;capture('complete',['Permintaan terpenuhi, armada tersedia','Request fulfilled, fleet available'],['Seluruh 360 ton diterima. Delapan ritase kembali terverifikasi dan keempat truk tersedia; stok, reservasi, ledger dan antrean ERP tetap cocok.','All 360 tonnes are received. Eight trips have verified returns and all four trucks are available; stock, reservations, ledger and ERP outbox remain reconciled.']);
 const product=state.products[0],jetty=state.jetties[0];
 return {version:1,source:'IN_MEMORY_DOMAIN_REPLAY',synthetic:true,productionEvidence:false,readOnly:true,model:'STATIC_WIM',requestedT:360,requestedM3:240,requestId,dispatchId:dispatch.id,sku:{id:product.id,code:product.code,densityTPerM3:product.densityTPerM3},jetty:{id:jetty.id,code:jetty.code},vessel:{id:vessel.id,name:vessel.name,payloadLimitT:vessel.payloadLimitT},trucks:state.trucks.map((truck,index)=>{const first=queues[index][0],crusher=state.crushers.find(row=>row.id===first.crusherId);return {id:truck.id,code:truck.code,plate:truck.plate,crusherId:first.crusherId,crusherCode:crusher.code,stockpileId:first.stockpileId,dispatchId:dispatch.id,dispatchCode:dispatch.code,tripIds:queues[index].map(trip=>trip.id)};}),frames,duration:at};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const replay=generateQuarryFlowReplay(),destination=new URL('../public/quarry-flow-replay.json',import.meta.url);
 await writeFile(destination,JSON.stringify(replay));
 process.stdout.write(`Generated ${replay.frames.length} synthetic domain frames, ${replay.duration}s, 4 trucks, 8 trips, 360t.\n`);
}
