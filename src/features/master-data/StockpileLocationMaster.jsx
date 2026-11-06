import React,{useRef,useState} from 'react';
import {Check,MapPin,Plus,Trash2} from 'lucide-react';
import {tr,useLanguage} from '../../i18n.js';
import {Badge,Button,DataTable,Field,Modal,Panel} from '../../components/ui/index.jsx';
import './stockpile-location-master.css';

const modes=['LAND','MARINE'];
const emptyDraft=()=>({name:'',address:'',transportModes:['LAND','MARINE']});
const toDraft=record=>record?{id:record.id,name:record.name||'',address:record.address||'',transportModes:modes.filter(mode=>(record.transportModes||[]).includes(mode))}:emptyDraft();

/** Physical destination master. Lists and mutations stay in the shared parent. */
export function StockpileLocationMaster({
  stockpileLocations=[],locationBusy=false,locationError='',
  onLocationSave,onLocationDelete
}){
  const language=useLanguage();
  const L=(id,en)=>language==='en'?en:id;
  const [editor,setEditor]=useState(null);
  const [draft,setDraft]=useState(emptyDraft);
  const [deleting,setDeleting]=useState(null);
  const [submitting,setSubmitting]=useState(false);
  const [validation,setValidation]=useState('');
  const [failed,setFailed]=useState(false);
  const [exception,setException]=useState('');
  const pending=useRef(false);
  const items=Array.isArray(stockpileLocations)?stockpileLocations:[];
  const working=locationBusy||submitting;
  const canSave=typeof onLocationSave==='function';
  const canDelete=typeof onLocationDelete==='function';
  const errors={
    name:L('Isi nama lokasi stockpile.','Enter a stockpile location name.'),
    mode:L('Pilih sedikitnya satu moda pengiriman.','Choose at least one transport mode.'),
    unavailable:L('Pengelolaan lokasi belum tersedia. Muat ulang aplikasi.','Location management is unavailable. Reload the application.')
  };
  const remoteError=typeof locationError==='string'?locationError:locationError?.message||locationError?.text||'';
  const visibleError=validation?errors[validation]:failed?tr(remoteError||exception)||L('Perubahan belum tersimpan. Periksa pesan aplikasi lalu coba lagi.','The change was not saved. Review the application message and try again.'):'';
  const resetError=()=>{setValidation('');setFailed(false);setException('');};
  const open=record=>{if(working)return;resetError();setDraft(toDraft(record));setEditor(record?.id||'new');};
  const change=(key,value)=>{setDraft(previous=>({...previous,[key]:value}));setValidation('');};
  const closeEditor=()=>{if(!pending.current)setEditor(null);};
  const closeDelete=()=>{if(!pending.current)setDeleting(null);};
  const modeLabel=mode=>mode==='LAND'?L('Darat (LAND)','Road (LAND)'):L('Laut (MARINE)','Marine (MARINE)');
  const editingRecord=items.find(record=>record.id===editor);
  const validate=()=>{
    if(!draft.name.trim())return 'name';
    if(!draft.transportModes.length)return 'mode';
    return '';
  };
  const save=async event=>{
    event.preventDefault();
    if(working||pending.current)return;
    resetError();
    const invalid=validate();
    if(invalid){setValidation(invalid);return;}
    if(!canSave){setValidation('unavailable');return;}
    const payload={...(draft.id?{id:draft.id}:{}),name:draft.name.trim(),address:draft.address.trim(),transportModes:modes.filter(mode=>draft.transportModes.includes(mode))};
    pending.current=true;setSubmitting(true);
    try{
      const result=await onLocationSave(payload);
      if(result==null){setFailed(true);return;}
      setEditor(null);
    }catch(error){setException(error?.message||'');setFailed(true);}
    finally{pending.current=false;setSubmitting(false);}
  };
  const remove=async()=>{
    if(working||pending.current)return;
    resetError();
    if(!canDelete){setValidation('unavailable');return;}
    pending.current=true;setSubmitting(true);
    try{
      const result=await onLocationDelete(deleting.id);
      if(result==null){setFailed(true);return;}
      setDeleting(null);
    }catch(error){setException(error?.message||'');setFailed(true);}
    finally{pending.current=false;setSubmitting(false);}
  };
  const addButton=<Button icon={Plus} data-testid="stockpile-location-add" disabled={working||!canSave} onClick={()=>open()}>{L('Tambah lokasi stockpile','Add stockpile location')}</Button>;
  return <div className="stockpile-location-master" data-testid="stockpile-location-master">
    <Panel title={L('Lokasi stockpile','Stockpile locations')}
      subtitle={L('Tujuan fisik pengiriman material melalui darat atau laut.','Physical material delivery destinations by road or marine transport.')}
      action={items.length?addButton:null}>
      <div className="stockpile-location-explainer"><MapPin size={20}/><p>{L('Tambahkan nama, alamat, dan moda pengiriman lokasi. Kode lokasi unik dibuat otomatis oleh sistem saat disimpan.','Enter the location name, address and transport modes. The system generates a unique location code when saved.')}</p></div>
      {items.length?<DataTable headers={[L('Kode lokasi','Location code'),L('Nama & alamat','Name & address'),L('Moda pengiriman','Transport modes'),L('Status','Status'),L('Aksi','Actions')]}>
        {items.map(record=>{
          return <tr key={record.id} data-location-id={record.id}>
            <td><b>{record.code}</b></td>
            <td><b>{record.name}</b><small>{record.address||L('Alamat belum diisi','Address not entered')}</small></td>
            <td><div className="stockpile-location-modes">{modes.filter(mode=>(record.transportModes||[]).includes(mode)).map(mode=><Badge key={mode} tone="blue">{modeLabel(mode)}</Badge>)}</div></td>
            <td><Badge tone={record.active!==false?'green':'neutral'}>{record.active!==false?L('Aktif','Active'):L('Nonaktif','Inactive')}</Badge></td>
            <td><div className="row-actions"><button type="button" className="text-btn" aria-label={`${L('Edit','Edit')} ${record.code}`} disabled={working||!canSave} onClick={()=>open(record)}>{L('Edit','Edit')}</button><button type="button" className="text-btn danger" aria-label={`${L('Hapus','Delete')} ${record.code}`} disabled={working||!canDelete} onClick={()=>{resetError();setDeleting(record);}}><Trash2 size={13}/>{L('Hapus','Delete')}</button></div></td>
          </tr>;
        })}
      </DataTable>:<div className="stockpile-location-empty"><MapPin size={30}/><h3>{L('Belum ada lokasi stockpile','No stockpile locations yet')}</h3><p>{L('Tambahkan tujuan pengiriman terlebih dahulu agar dapat dipilih pada permintaan transfer LAND dan MARINE.','Add a delivery destination so it can be selected on LAND and MARINE transfer requests.')}</p>{addButton}</div>}
    </Panel>
    {editor&&<Modal title={editor==='new'?L('Tambah lokasi stockpile','Add stockpile location'):L('Edit lokasi stockpile','Edit stockpile location')}
      subtitle={L('Data ini menjadi pilihan tujuan pada permintaan transfer, bukan saldo persediaan SKU.','This record is a transfer destination choice, not a SKU inventory balance.')}
      onClose={closeEditor}>
      <form onSubmit={save} noValidate data-testid="stockpile-location-form">
        <div className="stockpile-location-code-note" data-testid="stockpile-location-code-note" role="status">{editor==='new'?<p>{L('Kode lokasi unik dibuat otomatis saat disimpan.','A unique location code is generated when saved.')}</p>:<p>{L('Kode lokasi','Location code')}: <b>{editingRecord?.code||'—'}</b><small>{L('Kode lokasi tidak dapat diubah.','The location code cannot be changed.')}</small></p>}</div>
        <fieldset className="stockpile-location-fields" disabled={working}>
          <div className="form-grid">
            <Field label={L('Nama lokasi','Location name')}><input required maxLength={160} value={draft.name} onChange={event=>change('name',event.target.value)} autoComplete="off"/></Field>
          </div>
          <Field label={L('Alamat lokasi (opsional)','Location address (optional)')}><textarea rows={3} maxLength={500} value={draft.address} onChange={event=>change('address',event.target.value)}/></Field>
          <fieldset className="stockpile-location-transport"><legend>{L('Moda pengiriman yang dilayani','Supported transport modes')}</legend>{modes.map(mode=><label key={mode}><input type="checkbox" checked={draft.transportModes.includes(mode)} onChange={event=>change('transportModes',event.target.checked?[...new Set([...draft.transportModes,mode])]:draft.transportModes.filter(value=>value!==mode))}/><span>{modeLabel(mode)}</span></label>)}</fieldset>
        </fieldset>
        {visibleError&&<div className="form-error" role="alert">{visibleError}</div>}
        <div className="modal-actions"><Button variant="secondary" disabled={submitting} onClick={closeEditor}>{L('Batal','Cancel')}</Button><Button icon={Check} type="submit" data-testid="stockpile-location-save" disabled={working||!canSave}>{submitting?L('Menyimpan…','Saving…'):L('Simpan lokasi','Save location')}</Button></div>
      </form>
    </Modal>}
    {deleting&&<Modal title={L('Hapus lokasi stockpile','Delete stockpile location')} subtitle={`${deleting.code} · ${deleting.name}`} onClose={closeDelete}>
      <p className="stockpile-location-delete-copy">{L('Lokasi yang sudah memiliki riwayat transaksi tidak dapat dihapus agar referensi pengiriman tetap utuh.','A location with transaction history cannot be deleted so delivery references remain intact.')}</p>
      {visibleError&&<div className="form-error" role="alert">{visibleError}</div>}
      <div className="modal-actions"><Button variant="secondary" disabled={submitting} onClick={closeDelete}>{L('Batal','Cancel')}</Button><Button icon={Trash2} variant="danger" data-testid="stockpile-location-delete-confirm" disabled={working||!canDelete} onClick={remove}>{submitting?L('Menghapus…','Deleting…'):L('Hapus lokasi','Delete location')}</Button></div>
    </Modal>}
  </div>;
}
