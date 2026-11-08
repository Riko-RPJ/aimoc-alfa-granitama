import React from 'react';
import {ArrowUpRight,QrCode,Route,Truck} from 'lucide-react';
import {Modal} from '../../components/ui/index.jsx';
import {AssignmentQr} from './AssignmentQr.jsx';

export const quarryTaskHref=trip=>'/quarry-cilegon?trip='+encodeURIComponent(trip.id);
export function QuarryAssignmentHandoff({trip,user,L,blocked,onClose,source,destination,truck}){
 const value=trip.quarry?.dispatchPass?.value,vehicle=truck?.(trip.truckId);
 return <Modal wide title={`${trip.code} · Quarry Cilegon`} subtitle={L('Penugasan timbang dan penerimaan terpisah mengikuti ritase yang sama.','Weighing and independent receiving follow the same trip.')} onClose={onClose}>
  <div className="ig-form-note" data-testid="quarry-assignment-handoff"><Route size={20}/><div><b>{L('Lanjutkan melalui gerbang Cilegon','Continue through Cilegon gates')}</b><p>{L('Workflow ini menggunakan QR/tare masuk, pemuatan, QR/gross keluar, konfirmasi jetty dan QR kembali. Dua-scan Driver lama tidak dipakai untuk menyelesaikan bongkar.','This workflow uses entry QR/tare, loading, exit QR/gross, independent jetty confirmation and return QR. The older two-scan Driver flow does not complete unloading.')}</p></div></div>
  <div className="ig-trip-summary"><div><small>{L('Sumber','Source')}</small><b>{source?.(trip)||`${trip.sourceCrusherCode} / ${trip.sourceStockpileCode}`}</b></div><div><small>{L('Jetty / kapal tujuan','Destination jetty / vessel')}</small><b>{destination?.(trip)||trip.vesselId||'—'}</b></div><div><small>Dispatch / {L('ritase','trip')}</small><b>{trip.dispatchId} / {trip.code}</b></div><div><small>{L('Truk / Driver','Truck / Driver')}</small><b>{vehicle?.code||trip.truckCode||trip.truckId||L('Menunggu alokasi','Awaiting allocation')} / {trip.driverName||trip.assignedDriverUserId||'—'}</b></div><div><small>{L('Status','Status')}</small><b>{trip.status}</b></div></div>
  {!blocked&&value?<div style={{maxWidth:270,margin:'20px auto'}}><AssignmentQr value={value} label={L('QR truk + dispatch · ritase tetap dicatat terpisah','Truck + dispatch QR · individual trips remain separate')}/></div>:<p>{L('QR tampil setelah pasangan truk–Driver dialokasi dan data tersinkron.','The QR becomes visible after truck–Driver allocation and synchronization.')}</p>}
  <p>{user.role==='driver'?L('Driver melihat antrean miliknya dan dapat mulai sesuai urutan. Operator sumber mencatat timbang; operator jetty mencatat penerimaan.','The Driver sees their own queue and starts work in order. Source staff record weighing; jetty staff record receipt.'):L('Timbang dan verifikasi kembali dilakukan oleh operator sumber; penerimaan dilakukan di jetty.','Weighing and return verification belong to source staff; receipt belongs to jetty staff.')}</p>
  <div className="modal-actions"><button className="qc-button" onClick={onClose}>{L('Tutup','Close')}</button><a className="qc-button primary" href={quarryTaskHref(trip)} style={{textDecoration:'none'}}><Truck size={16}/>{L('Buka tugas di Cilegon','Open task in Cilegon')}<ArrowUpRight size={15}/></a></div>
 </Modal>;
}
