import React,{useState} from 'react';
import {Loader2,Pencil,XCircle} from 'lucide-react';
import {Button,Field,Modal} from '../../components/ui/index.jsx';
import './request-edit-cancel.css';

export function canMutateRequest(request,action){
 return request?.[action==='edit'?'canEdit':'canCancel']===true&&Number.isSafeInteger(request.requestRevision)&&request.requestRevision>=1;
}
export function requestMutationReason(request,action,L){
 const field=action==='edit'?'editBlockedReason':'cancelBlockedReason';
 return L(request?.[field]||'Edit dan pembatalan hanya tersedia sebelum Rencanakan Dispatch.',request?.[field+'En']||'Editing and cancellation are available only before Plan Dispatch.');
}

export function RequestRowActions({request,role,blocked,planning,L,onPlan,onDetail,onEdit,onCancel}){
 if(role!=='admin')return <button className="ig-link" data-request-detail={request.id} onClick={onDetail}>{L('Detail','Details')}</button>;
 const editAllowed=canMutateRequest(request,'edit'),cancelAllowed=canMutateRequest(request,'cancel');
 return <div className="ig-request-row-actions" data-request-actions={request.id}>
  <div className="ig-request-row-primary">{request.status==='requested'&&<Button disabled={blocked||!editAllowed} title={!editAllowed?requestMutationReason(request,'edit',L):undefined} data-request-plan={request.id} onClick={onPlan}>{planning?<><Loader2 size={15} className="spin"/>{L('Merencanakan otomatis…','Planning automatically…')}</>:L('Rencanakan dispatch','Plan dispatch')}</Button>}<button className="ig-link" data-request-detail={request.id} onClick={onDetail}>{L('Detail','Details')}</button></div>
  <div className="ig-request-mutation-buttons">
   <Button variant="secondary" icon={Pencil} data-testid="request-edit" data-request-edit={request.id} disabled={blocked||!editAllowed} title={!editAllowed?requestMutationReason(request,'edit',L):undefined} onClick={onEdit}>{L('Edit','Edit')}</Button>
   <Button variant="secondary" icon={XCircle} data-testid="request-cancel" data-request-cancel={request.id} disabled={blocked||!cancelAllowed} title={!cancelAllowed?requestMutationReason(request,'cancel',L):undefined} onClick={onCancel}>{L('Batalkan','Cancel request')}</Button>
  </div>
  {(!editAllowed||!cancelAllowed)&&<small className="ig-request-action-reason" data-testid="request-action-reason">{requestMutationReason(request,!editAllowed?'edit':'cancel',L)}</small>}
 </div>;
}

export function RequestCancelModal({request,initialRequest,expectedRequestRevision,blocked,L,fmt,products,destinationText,onClose,onSubmit}){
 const [reason,setReason]=useState('');
 const current=request||initialRequest,changed=request?.requestRevision!==expectedRequestRevision;
 const permitted=canMutateRequest(request,'cancel'),disabled=blocked||!permitted||changed;
 const blockedReason=!permitted?requestMutationReason(request,'cancel',L):changed?L('Permintaan telah diperbarui. Tutup dialog dan periksa data terbaru sebelum membatalkan.','The request has changed. Close this dialog and review the latest data before cancelling.'):'';
 return <Modal title={L('Batalkan permintaan transfer','Cancel transfer request')} subtitle={L('Periksa permintaan yang akan dibatalkan. Riwayatnya tetap disimpan.','Review the request to cancel. Its history will be retained.')} onClose={onClose}>
  <form data-testid="request-cancel-form" onSubmit={event=>{event.preventDefault();if(disabled)return;const value=reason.trim();onSubmit({requestId:initialRequest.id,expectedRequestRevision,...(value?{reason:value}:{})});}}>
   <div className="ig-request-cancel-summary"><b>{current.code||current.id}</b><span>{destinationText||'—'}</span>{(current.lines||[]).map((line,index)=><small key={index}>{products.find(product=>product.id===line.skuId)?.code||line.skuId} · {fmt(line.quantity,6)} {line.unit==='m3'?'m³':'t'}</small>)}</div>
   <p className="ig-form-note">{L('Pembatalan hanya diperbolehkan sebelum Admin merencanakan dispatch. Permintaan yang dibatalkan tidak dapat direncanakan lagi.','Cancellation is allowed only before Admin plans dispatch. A cancelled request cannot be planned again.')}</p>
   {blockedReason&&<p className="form-error" role="alert" data-testid="request-cancel-locked">{blockedReason}</p>}
   <Field label={L('Alasan pembatalan (opsional)','Cancellation reason (optional)')}><textarea data-testid="request-cancel-reason" maxLength={500} rows={3} value={reason} disabled={disabled} onChange={event=>setReason(event.target.value)}/></Field>
   <div className="modal-actions"><Button variant="secondary" onClick={onClose}>{L('Kembali','Go back')}</Button><Button type="submit" data-testid="request-cancel-confirm" disabled={disabled} icon={XCircle}>{L('Ya, batalkan permintaan','Yes, cancel request')}</Button></div>
  </form>
 </Modal>;
}
