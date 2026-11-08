import {DomainError} from './domain.mjs';

const SCALE=1e6,EPS=0.00001;
const units=value=>Math.round(value*SCALE);
const quantity=value=>value/SCALE;
const fail=(message,code='INSUFFICIENT_STOCK')=>{throw new DomainError(message,code,409);};

/** New Cilegon plans share a SKU across crushers, then use each crusher's bins.
 * Integer micro-units keep the final source remainders equal to the request.
 * Existing dispatch allocations are never passed through this planner.
 */
export function quarrySourceBudgets(stocks,line){
 const groups=new Map(),budgets=new Map();
 for(const stock of stocks){
  const availableM3=Math.max(0,units(stock.onHandM3-stock.reservedM3));
  const capacityT=units(quantity(availableM3)*line.densityTPerM3);
  if(!availableM3||!capacityT)continue;
  const group=groups.get(stock.crusherId)||{id:stock.crusherId,capacityT:0,budgetT:0,bins:[]};
  group.capacityT+=capacityT;group.bins.push({stock,availableM3,capacityT});groups.set(group.id,group);
 }
 let remainingT=units(line.tonnageT);
 if([...groups.values()].reduce((sum,g)=>sum+g.capacityT,0)<remainingT)fail('Stok SKU lintas crusher tidak mencukupi.');
 // Capped equal shares prevent a large first crusher from taking the full line.
 while(remainingT>0){
  const eligible=[...groups.values()].filter(g=>g.budgetT<g.capacityT).sort((a,b)=>a.id.localeCompare(b.id));
  if(!eligible.length)fail('Stok SKU lintas crusher tidak mencukupi.');
  const share=Math.floor(remainingT/eligible.length),extra=remainingT%eligible.length;
  for(const [index,group] of eligible.entries()){
   const take=Math.min(group.capacityT-group.budgetT,share+(index<extra?1:0));
   group.budgetT+=take;remainingT-=take;
  }
 }
 const pieces=[];
 for(const group of groups.values()){
  let remaining=group.budgetT;
  for(const bin of group.bins){
   const tonnageT=Math.min(remaining,bin.capacityT);if(!tonnageT)continue;
   const volumeM3=Math.min(bin.availableM3,units(quantity(tonnageT)/line.densityTPerM3));
   if(volumeM3<=0)fail('Kuantitas terlalu kecil untuk presisi volume demo.','QUANTITY_PRECISION');
   pieces.push({...bin,tonnageT,volumeM3});remaining-=tonnageT;
   if(!remaining)break;
  }
 }
 // Correct one micro-unit at a time at the bin with the best density bias.
 // A small heap avoids concentrating accumulated rounding in the final bin.
 let volumeRemainder=units(line.volumeM3)-pieces.reduce((sum,p)=>sum+p.volumeM3,0);
 const direction=Math.sign(volumeRemainder),heap=[];
 const hasRoom=piece=>direction>0?piece.volumeM3<piece.availableM3:piece.volumeM3>1;
 const score=piece=>direction*(piece.volumeM3*line.densityTPerM3-piece.tonnageT);
 const less=(a,b)=>a.score<b.score||a.score===b.score&&a.index<b.index;
 const push=entry=>{
  heap.push(entry);let position=heap.length-1;
  while(position>0){const parent=Math.floor((position-1)/2);if(!less(heap[position],heap[parent]))break;[heap[position],heap[parent]]=[heap[parent],heap[position]];position=parent;}
 };
 const pop=()=>{
  const first=heap[0],last=heap.pop();if(!heap.length)return first;
  heap[0]=last;let position=0;
  for(;;){let child=position*2+1;if(child>=heap.length)break;if(child+1<heap.length&&less(heap[child+1],heap[child]))child++;if(!less(heap[child],heap[position]))break;[heap[position],heap[child]]=[heap[child],heap[position]];position=child;}
  return first;
 };
 if(direction)for(const [index,piece] of pieces.entries())if(hasRoom(piece))push({piece,index,score:score(piece)});
 while(volumeRemainder){
  if(!heap.length)fail('Volume SKU lintas crusher tidak mencukupi.');
  const entry=pop();entry.piece.volumeM3+=direction;volumeRemainder-=direction;
  if(hasRoom(entry.piece)){entry.score=score(entry.piece);push(entry);}
 }
 for(const piece of pieces){
  const budget={tonnageT:quantity(piece.tonnageT),volumeM3:quantity(piece.volumeM3)};
  if(Math.abs(budget.volumeM3*line.densityTPerM3-budget.tonnageT)>EPS)fail('Kuantitas sumber tidak cocok dengan densitas SKU.','QUANTITY_PRECISION');
  budgets.set(piece.stock.id,budget);
 }
 return budgets;
}
