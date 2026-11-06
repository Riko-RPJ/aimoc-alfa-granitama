import React from 'react';
import './measurement-units.css';

const known=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

// Show persisted source units and server conversion only. Historical records do
// not have a density snapshot; do not invent one from today's product master.
export function MeasurementValues({measurement,L=(id)=>id,fmt=(value)=>String(value)}){
 const original=known(measurement.quantityValue)&&['m3','t'].includes(measurement.quantityUnit);
 const volume=known(measurement.volumeM3),tonnage=known(measurement.tonnageT);
 const density=known(measurement.densityTPerM3Snapshot)&&measurement.densityTPerM3Snapshot>0;
 const unit=measurement.quantityUnit==='t'?L('ton','t'):'m³';
 return <div className="measurement-record-values" data-testid="measurement-record-values" data-measurement-id={measurement.id}>
  {original?<><small>{L('Nilai asli tercatat','Recorded source value')}</small><b data-testid="measurement-original-value" data-unit={measurement.quantityUnit} data-value={measurement.quantityValue}>{fmt(measurement.quantityValue,6)} {unit}</b></>:<b>{volume?`${fmt(measurement.volumeM3,6)} m³`:'—'}</b>}
  {original&&<small data-testid="measurement-record-volume" data-value={volume?measurement.volumeM3:undefined}>{L('Volume persediaan','Inventory volume')}: {volume?`${fmt(measurement.volumeM3,6)} m³`:'—'}</small>}
  {tonnage&&<small data-testid="measurement-record-tonnage" data-value={measurement.tonnageT}>{L('Tonase tercatat','Recorded tonnes')}: {fmt(measurement.tonnageT,6)} {L('ton','t')}</small>}
  {density&&<small>{L('Berat jenis saat pencatatan','Density at recording')}: {fmt(measurement.densityTPerM3Snapshot,6)} t/m³</small>}
 </div>;
}
