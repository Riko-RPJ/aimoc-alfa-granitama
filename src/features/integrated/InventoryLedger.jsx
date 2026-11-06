import React,{useEffect,useState} from 'react';
import {Layers3} from 'lucide-react';
import './inventory-ledger.css';

const list=value=>Array.isArray(value)?value:[];
const number=value=>Number(value)||0;
const known=value=>typeof value==='number'&&Number.isFinite(value);
const ALL='all',UNASSIGNED='__unassigned_area__';

export function InventoryLedger({stockpiles,products,crushers,trips,L,fmt}){
 const [areaFilter,setAreaFilter]=useState(ALL),[stockpileFilter,setStockpileFilter]=useState(ALL);
 const piles=list(stockpiles),productById=new Map(list(products).map(p=>[p.id,p])),areaById=new Map(list(crushers).map(c=>[c.id,c]));
 const areaId=pile=>pile.crusherId||UNASSIGNED;
 const areaIds=[...new Set(piles.map(areaId))];
 const effectiveArea=areaFilter===ALL||areaIds.includes(areaFilter)?areaFilter:ALL;
 const areaPiles=piles.filter(pile=>effectiveArea===ALL||areaId(pile)===effectiveArea);
 const effectiveStockpile=stockpileFilter===ALL||areaPiles.some(pile=>pile.id===stockpileFilter)?stockpileFilter:ALL;
 const visiblePiles=areaPiles.filter(pile=>effectiveStockpile===ALL||pile.id===effectiveStockpile);
 const groups=[...new Set(visiblePiles.map(areaId))].map(id=>({id,area:areaById.get(id),piles:visiblePiles.filter(pile=>areaId(pile)===id)}));
 useEffect(()=>{if(areaFilter!==effectiveArea)setAreaFilter(effectiveArea);},[areaFilter,effectiveArea]);
 useEffect(()=>{if(stockpileFilter!==effectiveStockpile)setStockpileFilter(effectiveStockpile);},[stockpileFilter,effectiveStockpile]);
 const areaName=id=>{const area=areaById.get(id);return area?`${area.code||''}${area.code&&area.name?' · ':''}${area.name||''}`:id===UNASSIGNED?L('Area stok belum ditentukan','Inventory area not specified'):id;};
 const headers=[L('Stockpile / area stok','Stockpile / inventory area'),'SKU',L('Stok tercatat','On hand'),L('Direservasi','Reserved'),L('Tersedia','Available'),L('Dalam perjalanan dari sumber','In transit from source'),L('Diterima ke lokasi ini','Received at this location')];
 return <section className="ig-panel ig-inventory-ledger" data-testid="inventory-ledger" aria-labelledby="inventory-ledger-title">
  <div className="ig-panel-head"><div><h2 id="inventory-ledger-title">{L('Persediaan per stockpile / area stok','Inventory by stockpile / area')}</h2><p>{L('Stok tercatat berkurang saat berangkat dan bertambah saat penerimaan LAND. Reservasi mengurangi stok bebas, bukan menambah stok fisik.','On-hand stock decreases at departure and increases on LAND receipt. Reservations reduce free stock; they do not add physical stock.')}</p></div><Layers3 size={22} aria-hidden="true"/></div>
  <div className="ig-inventory-filters">
   <label className="ig-filter"><span>{L('Kelompok area stok','Inventory area group')}</span><select data-testid="inventory-area-filter" aria-label={L('Filter area stok','Inventory area filter')} value={effectiveArea} onChange={event=>{setAreaFilter(event.target.value);setStockpileFilter(ALL);}}><option value={ALL}>{L('Semua area stok','All inventory areas')}</option>{areaIds.map(id=><option key={id} value={id}>{areaName(id)}</option>)}</select></label>
   <label className="ig-filter"><span>{L('Stockpile','Stockpile')}</span><select data-testid="inventory-stockpile-filter" aria-label={L('Filter stockpile','Stockpile filter')} value={effectiveStockpile} onChange={event=>setStockpileFilter(event.target.value)}><option value={ALL}>{L('Semua stockpile','All stockpiles')}</option>{areaPiles.map(pile=><option key={pile.id} value={pile.id}>{pile.code||pile.id}{productById.get(pile.skuId)?.code?` · ${productById.get(pile.skuId).code}`:''}</option>)}</select></label>
  </div>
  <p className="ig-inventory-filter-note">{L('Filter hanya mengubah rincian di bawah. Ringkasan SKU dan jumlah stockpile tetap mencakup seluruh persediaan sesuai hak akses Anda.','Filters only change the details below. SKU and stockpile summaries still cover all inventory within your access.')}</p>
  {piles.some(pile=>!known(pile.onHandM3)||!known(pile.reservedM3))&&<p className="ig-inventory-filter-note" role="note">{L('Tanda — berarti saldo tidak tersedia pada tampilan ini, termasuk bila dibatasi hak akses. Nilai tersebut tidak dihitung sebagai nol.','A — means the balance is unavailable in this view, including access restrictions. It is not treated as zero.')}</p>}
  <div className="ig-inventory-result-count" aria-live="polite">{L(`${visiblePiles.length} stockpile ditampilkan dalam ${groups.length} area stok`,`${visiblePiles.length} stockpiles shown in ${groups.length} inventory areas`)}</div>
  {!groups.length?<div className="ig-empty">{L('Tidak ada stockpile yang sesuai dengan filter.','No stockpiles match these filters.')}</div>:groups.map(group=><article className="ig-inventory-area" key={group.id} data-inventory-area={group.id}>
   <div className="ig-inventory-area-head"><h3 data-area-id={group.id}>{areaName(group.id)}</h3><span>{group.piles.length} {L('stockpile','stockpiles')}</span></div>
   <div className="ig-table-scroll"><table className="ig-table ig-inventory-table"><thead><tr>{headers.map(header=><th key={header}>{header}</th>)}</tr></thead><tbody>{group.piles.map(pile=>{
    const product=productById.get(pile.skuId),outbound=list(trips).filter(trip=>trip.stockpileId===pile.id&&['in_transit','arrived'].includes(trip.status)),received=list(trips).filter(trip=>trip.destinationStockpileId===pile.id&&['unloaded','returning','returned'].includes(trip.status));
    return <tr key={pile.id} data-stockpile-id={pile.id} data-area-id={group.id}>
     <td><b>{pile.code||pile.id}</b><small>{areaName(group.id)}</small>{pile.active===false&&<small className="ig-inventory-inactive">{L('Nonaktif','Inactive')}</small>}</td>
     <td><b>{product?.code||pile.skuId||L('Belum ada SKU','No SKU assigned')}</b><small>{product?.name||(!product&&pile.skuId?L('SKU belum tersedia di master','SKU unavailable in master'):'')}</small></td>
     <td data-inventory-value="on-hand">{known(pile.onHandM3)?`${fmt(pile.onHandM3)} m³`:'—'}</td>
     <td data-inventory-value="reserved">{known(pile.reservedM3)?`${fmt(pile.reservedM3)} m³`:'—'}</td>
     <td data-inventory-value="available"><b>{known(pile.onHandM3)&&known(pile.reservedM3)?`${fmt(number(pile.onHandM3)-number(pile.reservedM3))} m³`:'—'}</b></td>
     <td>{outbound.every(trip=>known(trip.volumeM3))?`${fmt(outbound.reduce((sum,trip)=>sum+number(trip.volumeM3),0))} m³`:'—'}</td>
     <td>{received.every(trip=>known(trip.actualVolumeM3??trip.volumeM3))?`${fmt(received.reduce((sum,trip)=>sum+number(trip.actualVolumeM3??trip.volumeM3),0))} m³`:'—'}</td>
    </tr>;
   })}</tbody></table></div>
  </article>)}
 </section>;
}
