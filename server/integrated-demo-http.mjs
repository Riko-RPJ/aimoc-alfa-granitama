import {hash} from './auth.mjs';
import {applyIntegratedAction,integratedView} from './integrated-demo-domain.mjs';
import {requestDetail} from './request-detail.mjs';
import {summarizeSkuStocks} from './sku-stock-summary.mjs';

const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const validId=x=>typeof x==='string'&&/^[\w-]{1,100}$/.test(x);
const isIntegrated=x=>x?.source==='INTEGRATED_DEMO';
const open=x=>!['returned','cancelled'].includes(x.status);

// Keep compatibility endpoints from skipping the integrated state machine.
// In particular, legacy depart/return and the anonymous truck-code sidecar do
// not carry the Driver, QR or weigh-event identities required by this workflow.
export function guardLegacyIntegratedMutation(state,action,payload={}) {
  const linked=[...(state.trips||[]),...(state.requests||[]),...(state.dispatches||[])];
  if(linked.some(x=>isIntegrated(x)&&[payload.tripId,payload.requestId,payload.dispatchId].filter(Boolean).includes(x.id)))
    fail(409,'INTEGRATED_WORKFLOW_REQUIRED','Gunakan alur terpadu untuk transaksi ini.');
  const live=(state.trips||[]).filter(x=>isIntegrated(x)&&open(x));
  if(live.length&&(action==='request.plan'||action.startsWith('trip.')))
    fail(409,'INTEGRATED_WORKFLOW_REQUIRED','Selesaikan atau gunakan alur terpadu; reservasi armada tidak boleh dicampur dengan alur lama.');
  const match=/^master\.(product|crusher|stockpile|truck|jetty|vessel)\.(save|delete)$/.exec(action);
  if(match&&payload.id){
    const fields={product:['skuId'],crusher:['crusherId','destinationCrusherId'],stockpile:['stockpileId','destinationStockpileId'],truck:['truckId'],jetty:['jettyId'],vessel:['vesselId']}[match[1]];
    if(live.some(t=>fields.some(f=>t[f]===payload.id))){
      const keys={product:'products',crusher:'crushers',stockpile:'stockpiles',truck:'trucks',jetty:'jetties',vessel:'vessels'};
      const current=(state[keys[match[1]]]||[]).find(x=>x.id===payload.id);
      const protectedFields={product:['densityTPerM3','active'],crusher:['active'],stockpile:['crusherId','skuId','active'],truck:['bedM3','payloadLimitT','active'],jetty:['active'],vessel:['jettyId','payloadLimitT','active']}[match[1]];
      const changes=protectedFields.some(k=>payload[k]!==undefined&&String(payload[k])!==String(current?.[k]));
      const invalidVesselStatus=match[1]==='vessel'&&payload.status!==undefined&&payload.status!==current?.status&&payload.status!=='loading';
      // Display edits and opening a waiting vessel for loading do not rebind
      // a trip. Identity, physical limits and active-state changes are held.
      if(match[2]==='delete'||changes||invalidVesselStatus)
        fail(409,'ACTIVE_INTEGRATED_ASSIGNMENT','Identitas atau batas master masih dipakai transaksi terpadu aktif. Selesaikan transaksi terlebih dahulu.');
    }
  }
}

async function driversFor(db){
  const rows=(await db.query("SELECT id,username,display_name,role,active FROM aimoc_alfa_ops.users WHERE role='driver' AND active=true ORDER BY username")).rows;
  return rows.map(x=>({id:x.id,username:x.username,displayName:x.display_name,role:x.role,active:x.active}));
}
async function context(db,actor){
  const row=(await db.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
  if(!row)fail(503,'NOT_INITIALIZED','Data operasional belum diinisialisasi.');
  const drivers=await driversFor(db);
  return {state:integratedView(row.document,actor,{drivers}),revision:Number(row.revision),updatedAt:row.updated_at,
    source:'INTEGRATED_DEMO',drivers:actor.role==='admin'?drivers:drivers.filter(x=>x.id===actor.id)};
}

export async function handleIntegratedDemo({db,path,method,req,actor,send,parseBody}) {
  if(!['admin','stock','jetty','driver'].includes(actor.role))fail(403,'FORBIDDEN_SCOPE','Peran tidak didukung.');
  const detailPath=/^\/api\/v1\/demo\/requests\/([^/]+)\/detail$/.exec(path);
  if(detailPath){
    if(method!=='GET')fail(405,'METHOD_NOT_ALLOWED','Use GET.');
    let requestId;try{requestId=decodeURIComponent(detailPath[1]);}catch{fail(400,'INVALID_REQUEST_ID','Identitas permintaan tidak valid.');}
    if(!validId(requestId))fail(400,'INVALID_REQUEST_ID','Identitas permintaan tidak valid.');
    const row=(await db.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
    if(!row)fail(503,'NOT_INITIALIZED','Data operasional belum diinisialisasi.');
    const drivers=await driversFor(db);
    return send(200,{...requestDetail(row.document,actor,{requestId,drivers}),revision:Number(row.revision),updatedAt:row.updated_at,serverTime:new Date().toISOString()});
  }
  if(path==='/api/v1/demo/sku-stock'){
    if(method!=='GET')fail(405,'METHOD_NOT_ALLOWED','Use GET.');
    const params=new URL(req.url,'http://local').searchParams;
    if(params.getAll('transferMode').length>1||params.getAll('destinationCrusherId').length>1)
      fail(400,'INVALID_STOCK_QUERY','Parameter stok tidak boleh berulang.');
    const transferMode=params.get('transferMode')||'MARINE';
    const destinationCrusherId=params.get('destinationCrusherId')||undefined;
    if(destinationCrusherId&&!validId(destinationCrusherId))fail(400,'INVALID_STOCK_QUERY','Identitas area tujuan tidak valid.');
    const row=(await db.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
    if(!row)fail(503,'NOT_INITIALIZED','Data operasional belum diinisialisasi.');
    const summary=summarizeSkuStocks(row.document,actor,{transferMode,destinationCrusherId});
    return send(200,{...summary,revision:Number(row.revision),updatedAt:row.updated_at,serverTime:new Date().toISOString()});
  }
  if(path==='/api/v1/demo/context'){
    if(method!=='GET')fail(405,'METHOD_NOT_ALLOWED','Use GET.');
    return send(200,await context(db,actor));
  }
  if(path!=='/api/v1/demo/actions')fail(404,'RESOURCE_NOT_FOUND','Endpoint demo tidak tersedia.');
  if(method!=='POST')fail(405,'METHOD_NOT_ALLOWED','Use POST.');
  const body=await parseBody(req);
  if(!validId(body.requestId)||typeof body.action!=='string'||body.action.length>80||
      (body.payload!==undefined&&(!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))))
    fail(400,'INVALID_ACTION','Identitas dan payload aksi wajib valid.');
  if(body.expectedRevision!==undefined&&(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1))
    fail(400,'INVALID_REVISION','Revisi tidak valid.');
  const payload=body.payload||{},payloadHash=hash(JSON.stringify(['INTEGRATED_DEMO',body.action,payload]));
  const response=await db.transaction(async c=>{
    const row=(await c.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1 FOR UPDATE')).rows[0];
    if(!row)fail(503,'NOT_INITIALIZED','Data operasional belum diinisialisasi.');
    const previous=(await c.query('SELECT payload_hash,result FROM aimoc_alfa_ops.actions WHERE actor_id=$1 AND request_id=$2',[actor.id,body.requestId])).rows[0];
    // Retry receipts precede revision validation, so a lost response can always
    // be retried without repeating any inventory, capacity or ERP outbox entry.
    if(previous){
      if(previous.payload_hash!==payloadHash)fail(409,'IDEMPOTENCY_CONFLICT','ID aksi telah dipakai dengan isi berbeda.');
      return {...await context(c,actor),result:previous.result,replayed:true};
    }
    if(body.expectedRevision!==undefined&&body.expectedRevision!==Number(row.revision))
      fail(409,'REVISION_CONFLICT','Data telah diperbarui operator lain. Muat ulang lalu coba lagi.');
    const state=structuredClone(row.document),drivers=await driversFor(c);
    const result=applyIntegratedAction(state,body.action,payload,actor,{drivers});
    await c.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb,revision=revision+1,updated_at=now() WHERE id=1',[JSON.stringify(state)]);
    await c.query('INSERT INTO aimoc_alfa_ops.actions(actor_id,request_id,payload_hash,result) VALUES($1,$2,$3,$4::jsonb)',[actor.id,body.requestId,payloadHash,JSON.stringify(result)]);
    return {...await context(c,actor),result};
  });
  return send(200,response);
}
