import React,{useRef,useState} from 'react';
import {Check,MapPin,Plus,Trash2} from 'lucide-react';
import {tr,useLanguage} from '../../i18n.js';
import {Badge,Button,DataTable,Field,Modal,Panel} from '../../components/ui/index.jsx';
import './stockpile-location-master.css';

const modes=['LAND','MARINE'];
const emptyDraft=()=>({code:'',name:'',address:'',transportModes:['LAND','MARINE'],receivingCrusherId:'',active:true});
const toDraft=record=>record?{id:record.id,code:record.code||'',name:record.name||'',address:record.address||'',transportModes:modes.filter(mode=>(record.transportModes||[]).includes(mode)),receivingCrusherId:record.receivingCrusherId||'',active:record.active!==false}:emptyDraft();

/** Physical destination master. Lists and mutations stay in the shared parent. */
export function StockpileLocationMaster({
  stockpileLocations=[],crushers=[],locationBusy=false,locationError='',
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
  const areas=Array.isArray(crushers)?crushers:[];
  const working=locationBusy||submitting;
  const canSave=typeof onLocationSave==='function';
  const canDelete=typeof onLocationDelete==='function';
  const errors={
    code:L('Isi kode lokasi stockpile.','Enter a stockpile location code.'),
    name:L('Isi nama lokasi stockpile.','Enter a stockpile location name.'),
    mode:L('Pilih sedikitnya satu moda pengiriman.','Choose at least one transport mode.'),
    receiving:L('Pilih area stok penerima untuk pengiriman LAND.','Select a receiving stock area for LAND delivery.'),
    activeReceiving:L('Lokasi LAND aktif memerlukan area stok penerima yang aktif.','An active LAND location requires an active receiving stock area.'),
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
  const receiving=itemsRecord=>areas.find(area=>area.id===itemsRecord.receivingCrusherId);
  const validate=()=>{
    if(!draft.code.trim())return 'code';
    if(!draft.name.trim())return 'name';
    if(!draft.transportModes.length)return 'mode';
    if(draft.transportModes.includes('LAND')&&draft.active){
      if(!draft.receivingCrusherId)return 'receiving';
      const area=areas.find(item=>item.id===draft.receivingCrusherId);
      if(!area||(draft.active&&area.active===false))return 'activeReceiving';
    }
    return '';
  };
  const save=async event=>{
    event.preventDefault();
    if(working||pending.current)return;
    resetError();
    const invalid=validate();
    if(invalid){setValidation(invalid);return;}
    if(!canSave){setValidation('unavailable');return;}
    const payload={...(draft.id?{id:draft.id}:{}),code:draft.code.trim(),name:draft.name.trim(),address:draft.address.trim(),transportModes:modes.filter(mode=>draft.transportModes.includes(mode)),receivingCrusherId:draft.transportModes.includes('LAND')?draft.receivingCrusherId||null:null,active:!!draft.active};
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
      <div className="stockpile-location-explainer"><MapPin size={20}/><p>{L('Lokasi stockpile adalah tujuan fisik pengiriman. Master Stockpile tetap mencatat stok setiap SKU pada satu area stok. Untuk LAND, pilih area stok penerima secara eksplisit agar penerimaan menambah persediaan yang tepat.','A stockpile location is a physical delivery destination. The Stockpile master still tracks each SKU within a stock area. For LAND, explicitly select its receiving stock area so receipts update the correct inventory.')}</p></div>
      {items.length?<DataTable headers={[L('Kode lokasi','Location code'),L('Nama & alamat','Name & address'),L('Moda pengiriman','Transport modes'),L('Area stok penerima (LAND)','Receiving stock area (LAND)'),L('Status','Status'),L('Aksi','Actions')]}>
        {items.map(record=>{
          const area=receiving(record);
          return <tr key={record.id} data-location-id={record.id}>
            <td><b>{record.code}</b></td>
            <td><b>{record.name}</b><small>{record.address||L('Alamat belum diisi','Address not entered')}</small></td>
            <td><div className="stockpile-location-modes">{modes.filter(mode=>(record.transportModes||[]).includes(mode)).map(mode=><Badge key={mode} tone="blue">{modeLabel(mode)}</Badge>)}</div></td>
            <td>{(record.transportModes||[]).includes('LAND')?<><b>{area?.name||record.receivingCrusherId||L('Belum dipetakan','Not mapped')}</b>{area&&<small>{area.code}{area.active===false?` · ${L('Nonaktif','Inactive')}`:''}</small>}</>:<span className="stockpile-location-muted">{L('Tidak diperlukan untuk MARINE saja','Not required for MARINE only')}</span>}</td>
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
        <fieldset className="stockpile-location-fields" disabled={working}>
          <div className="form-grid two">
            <Field label={L('Kode lokasi','Location code')}><input required maxLength={64} value={draft.code} onChange={event=>change('code',event.target.value)} autoComplete="off" placeholder="SPL-01"/></Field>
            <Field label={L('Nama lokasi','Location name')}><input required maxLength={160} value={draft.name} onChange={event=>change('name',event.target.value)} autoComplete="off"/></Field>
          </div>
          <Field label={L('Alamat lokasi (opsional)','Location address (optional)')}><textarea rows={3} maxLength={500} value={draft.address} onChange={event=>change('address',event.target.value)}/></Field>
          <fieldset className="stockpile-location-transport"><legend>{L('Moda pengiriman yang dilayani','Supported transport modes')}</legend>{modes.map(mode=><label key={mode}><input type="checkbox" checked={draft.transportModes.includes(mode)} onChange={event=>change('transportModes',event.target.checked?[...new Set([...draft.transportModes,mode])]:draft.transportModes.filter(value=>value!==mode))}/><span>{modeLabel(mode)}</span></label>)}</fieldset>
          {draft.transportModes.includes('LAND')&&<Field label={L('Area stok penerima','Receiving stock area')} hint={L('Wajib untuk lokasi LAND aktif. SKU tujuan mengikuti stockpile per SKU pada area inventory yang dipilih.','Required for an active LAND location. Destination SKUs use the SKU stockpiles mapped to the selected inventory area.')}><select required={draft.active} value={draft.receivingCrusherId} onChange={event=>change('receivingCrusherId',event.target.value)}><option value="">{L('Pilih area stok penerima…','Select a receiving stock area…')}</option>{areas.filter(area=>area.active!==false||area.id===draft.receivingCrusherId).map(area=><option key={area.id} value={area.id}>{area.code} · {area.name}{area.active===false?` (${L('Nonaktif','Inactive')})`:''}</option>)}</select></Field>}
          <Field label={L('Status lokasi','Location status')}><select value={draft.active?'active':'inactive'} onChange={event=>change('active',event.target.value==='active')}><option value="active">{L('Aktif','Active')}</option><option value="inactive">{L('Nonaktif','Inactive')}</option></select></Field>
        </fieldset>
        {draft.transportModes.includes('LAND')&&!areas.some(area=>area.active!==false)&&draft.active&&<div className="stockpile-location-form-note">{L('Belum ada area stok penerima aktif. Aktifkan area melalui master Crusher sebelum menyimpan lokasi LAND aktif.','No active receiving stock area is available. Activate one in the Crusher master before saving an active LAND location.')}</div>}
        {visibleError&&<div className="form-error" role="alert">{visibleError}</div>}
        <div className="modal-actions"><Button variant="secondary" disabled={submitting} onClick={closeEditor}>{L('Batal','Cancel')}</Button><Button icon={Check} type="submit" data-testid="stockpile-location-save" disabled={working||!canSave||(draft.active&&draft.transportModes.includes('LAND')&&!areas.some(area=>area.active!==false))}>{submitting?L('Menyimpan…','Saving…'):L('Simpan lokasi','Save location')}</Button></div>
      </form>
    </Modal>}
    {deleting&&<Modal title={L('Hapus lokasi stockpile','Delete stockpile location')} subtitle={`${deleting.code} · ${deleting.name}`} onClose={closeDelete}>
      <p className="stockpile-location-delete-copy">{L('Lokasi yang sudah memiliki riwayat transaksi tidak dapat dihapus. Gunakan status Nonaktif melalui Edit untuk menghentikan pemilihan lokasi pada permintaan baru.','A location with transaction history cannot be deleted. Set its status to Inactive through Edit to stop selection on new requests.')}</p>
      {visibleError&&<div className="form-error" role="alert">{visibleError}</div>}
      <div className="modal-actions"><Button variant="secondary" disabled={submitting} onClick={closeDelete}>{L('Batal','Cancel')}</Button><Button icon={Trash2} variant="danger" data-testid="stockpile-location-delete-confirm" disabled={working||!canDelete} onClick={remove}>{submitting?L('Menghapus…','Deleting…'):L('Hapus lokasi','Delete location')}</Button></div>
    </Modal>}
  </div>;
}
