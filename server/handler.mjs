import {randomUUID} from 'node:crypto';
import {hash,token,passwordHash,checkPassword,userView,cookieValue,sessionCookie} from './auth.mjs';
import {applyAction,publicState} from './domain.mjs';
import {projectV1Read,isV1UnimplementedMutation} from './v1/read-model.mjs';
import {permissionsForRole,authorizeLegacyAction,TARGET_ADMIN_CAPABILITIES} from './role-permissions.mjs';
import {listCrusherLoadingPoints,saveCrusherLoadingPoint} from './crusher-location-master.mjs';
import {handleIntegratedDemo,guardLegacyIntegratedMutation} from './integrated-demo-http.mjs';

const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const validId=x=>typeof x==='string'&&/^[\w-]{1,100}$/.test(x);
const parseBody=async req=>{
  if(req.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body)) {if(Buffer.byteLength(JSON.stringify(req.body))>3000000)fail(413,'PAYLOAD_TOO_LARGE','Berkas terlalu besar.');return req.body;}
  if(typeof req.body==='string'){if(Buffer.byteLength(req.body)>3000000)fail(413,'PAYLOAD_TOO_LARGE','Berkas terlalu besar.');try{return JSON.parse(req.body);}catch{fail(400,'INVALID_JSON','Format permintaan tidak valid.');}}
  let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>3000000)fail(413,'PAYLOAD_TOO_LARGE','Berkas terlalu besar.');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{fail(400,'INVALID_JSON','Format permintaan tidak valid.');}
};

export function createHandler(db,{secure=false}={}) {
  return async function handle(req,res) {
    const send=(status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(data));};
    try {
      const url=new URL(req.url,'http://local');const path=url.pathname.replace(/\/$/,'');const method=req.method;
      if(method==='GET'&&path==='/api/health') {await db.query('SELECT 1');return send(200,{status:'ok',storage:'postgresql',app:'AIMOC Alfa Granitama',version:'1.0.0'});}
      if(!['GET','HEAD'].includes(method)) {
        const origin=req.headers.origin;const host=req.headers['x-forwarded-host']||req.headers.host;
        if(!origin||new URL(origin).host!==host)fail(403,'ORIGIN_REJECTED','Permintaan harus berasal dari aplikasi ini.');
        if(!String(req.headers['content-type']||'').startsWith('application/json'))fail(415,'CONTENT_TYPE','Gunakan JSON.');
      }
      // LOCAL UAT ONLY: truck code opens a read-only, truck-scoped task list.
      // It is NOT a privileged Driver session, and never records QR/TARE.
      if(path==='/api/driver/truck-tasks'){
        if(process.env.AIMOC_LOCAL_TRUCK_CODE_UAT!=='1')
          fail(404,'NOT_FOUND','Truck-code access is not enabled in this environment.');
        if(method!=='POST')fail(405,'METHOD_NOT_ALLOWED','Use POST.');
        const body=await parseBody(req);
        const truckCode=String(body.truckCode||'').trim().toUpperCase();
        if(!/^DT-[0-9]{3,6}$/.test(truckCode))
          fail(400,'INVALID_TRUCK_CODE','Masukkan kode truck, contoh DT-001.');
        const sourceIp=String(req.socket?.remoteAddress||'unknown');
        const key=hash('truck-lookup|'+sourceIp);
        const limit=(await db.query(`INSERT INTO aimoc_alfa_ops.login_limits(key) VALUES($1)
          ON CONFLICT(key) DO UPDATE SET
          attempts=CASE WHEN login_limits.window_at<now()-interval '15 minutes' THEN 1 ELSE login_limits.attempts+1 END,
          window_at=CASE WHEN login_limits.window_at<now()-interval '15 minutes' THEN now() ELSE login_limits.window_at END
          RETURNING attempts`,[key])).rows[0];
        if(limit.attempts>240)fail(429,'TOO_MANY_ATTEMPTS','Terlalu banyak pencarian kode truck.');
        const record=(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
        if(!record)fail(503,'NOT_INITIALIZED','Data operasional tidak tersedia.');
        const state=record.document;
        const truck=(state.trucks||[]).find(t=>t.code?.toUpperCase()===truckCode&&t.active!==false);
        if(!truck)fail(404,'TRUCK_NOT_FOUND','Kode truck tidak ditemukan atau tidak aktif.');
        const events=(await db.query(
          'SELECT trip_id,source,scanned_at FROM aimoc_alfa_ops.truck_qr_uat_events WHERE truck_id=$1 ORDER BY scanned_at DESC',
          [truck.id])).rows;
        const accessEvent=events[0]||null;
        if(!accessEvent)fail(403,'TRUCK_ACCESS_DENIED','Token akses QR UAT tidak valid untuk truck ini.');
        const progressRows=(await db.query(
          'SELECT trip_id,status,started_at,completed_at FROM aimoc_alfa_ops.truck_task_uat_progress WHERE truck_id=$1',
          [truck.id])).rows;
        const progress=new Map(progressRows.map(r=>[r.trip_id,r]));
        const allTrips=(state.trips||[]).filter(t=>t.source!=='INTEGRATED_DEMO'&&t.truckId===truck.id&&
          !['returned','cancelled'].includes(t.status)).sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));
        const current=allTrips.find(t=>progress.get(t.id)?.status!=='COMPLETED');
        const demoAvailable=allTrips.length>0&&allTrips.every(t=>progress.get(t.id)?.status==='COMPLETED');
        const awaitingCount=0;
        const trips=allTrips.map(t=>{
            const dispatch=(state.dispatches||[]).find(x=>x.id===t.dispatchId);
            const request=(state.requests||[]).find(x=>x.id===t.requestId);
            const stockpile=(state.stockpiles||[]).find(x=>x.id===t.stockpileId);
            const product=(state.products||[]).find(x=>x.id===t.skuId);
            const jetty=(state.jetties||[]).find(x=>x.id===t.jettyId);
            const vessel=(state.vessels||[]).find(x=>x.id===t.vesselId);
            return {tripCode:t.code,dispatchCode:dispatch?.code||null,requestCode:request?.code||null,
              truckCode,mode:request?.transferMode||'MARINE',status:t.status,
              tripId:t.id,
              qrAccess:{source:'ADMIN_SIMULATED_QR_UAT',scanTime:accessEvent.scanned_at,
               physicalScanVerified:false},
              uatTaskStatus:progress.get(t.id)?.status||'WAITING',
              uatCanStart:current?.id===t.id&&!progress.has(t.id),
              uatCanComplete:current?.id===t.id&&progress.get(t.id)?.status==='IN_PROGRESS',
              uatStartedAt:progress.get(t.id)?.started_at||null,
              uatCompletedAt:progress.get(t.id)?.completed_at||null,
              sequence:t.sequence??null,materialCode:product?.code||null,
              plannedVolumeM3:t.volumeM3??null,plannedTonnes:t.tonnageT??null,
              stockpileCode:stockpile?.code||null,
              destination:request?.transferMode==='LAND'?request.destination||null:vessel?.name||jetty?.name||null,
              estimatedStartAt:t.estimatedStartAt||null};
          });
        return send(200,{source:'LOCAL_UAT_LEGACY',data_status:trips.length?'READY':'EMPTY',
          access:'TRUCK_CODE_UAT_SIMULATION_ONLY',qr_scan:'PHYSICAL_NOT_VERIFIED',
          awaitingQrCount:awaitingCount,
          truck:{code:truck.code,availability:demoAvailable?'DEMO_AVAILABLE':(state.trips||[]).some(t=>t.truckId===truck.id&&!['queued','returned'].includes(t.status))?'IN_OPERATION':(state.trips||[]).some(t=>t.truckId===truck.id&&t.status==='queued')?'ALLOCATED':'AVAILABLE'},
          trips,revision:Number(record.revision)});
      }
      // UAT-only self-reported task progress; no legacy trip transition, TARE, or stock effects.
      if(path==='/api/driver/truck-task-action'){
        if(process.env.AIMOC_LOCAL_TRUCK_CODE_UAT!=='1')
          fail(404,'NOT_FOUND','Truck-code task simulator is disabled.');
        if(method!=='POST')fail(405,'METHOD_NOT_ALLOWED','Use POST.');
        const body=await parseBody(req);
        const truckCode=String(body.truckCode||'').trim().toUpperCase();
        const action=body.action;
        if(!/^DT-[0-9]{3,6}$/.test(truckCode)||!validId(body.tripId)||!['START','COMPLETE'].includes(action))
          fail(400,'INVALID_UAT_ACTION','Valid truck code, trip ID and START/COMPLETE required.');
        const result=await db.transaction(async c=>{
          // Shared lock serializes multiple devices attempting concurrent starts.
          const record=(await c.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1 FOR UPDATE')).rows[0];
          if(!record)fail(503,'NOT_INITIALIZED','Operational state unavailable');
          const state=record.document;
          const truck=(state.trucks||[]).find(x=>x.code===truckCode&&x.active!==false);
          if(!truck)fail(404,'TRUCK_NOT_FOUND','Truck not found');
          const all=(state.trips||[]).filter(t=>t.truckId===truck.id&&
            !['returned','cancelled'].includes(t.status))
            .sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));
          const target=all.find(t=>t.id===body.tripId);
          if(!target)fail(403,'TRIP_TRUCK_MISMATCH','Trip is not assigned to this truck');
          if(target.source==='INTEGRATED_DEMO')fail(409,'INTEGRATED_WORKFLOW_REQUIRED','Use the authenticated integrated Driver workspace.');
          const qr=(await c.query('SELECT trip_id FROM aimoc_alfa_ops.truck_qr_uat_events WHERE truck_id=$1 LIMIT 1',[truck.id])).rows[0];
          if(!qr)fail(409,'QR_NOT_SCANNED','Awaiting authorized QR simulation for truck');
          const progress=(await c.query('SELECT trip_id,status FROM aimoc_alfa_ops.truck_task_uat_progress WHERE truck_id=$1',[truck.id])).rows;
          const map=new Map(progress.map(r=>[r.trip_id,r.status]));
          const firstIncomplete=all.find(t=>map.get(t.id)!=='COMPLETED');
          const old=map.get(target.id);
          if(action==='START'){
            if(old==='IN_PROGRESS')return {status:'IN_PROGRESS',tripId:target.id,replayed:true};
            if(old==='COMPLETED')fail(409,'TASK_ALREADY_COMPLETED','Task already completed');
            if(firstIncomplete?.id!==target.id)
              fail(409,'SERIAL_ORDER_REQUIRED','Finish earlier truck task before starting this one');
            await c.query(`INSERT INTO aimoc_alfa_ops.truck_task_uat_progress(trip_id,truck_id,status)
             VALUES($1,$2,'IN_PROGRESS')`,[target.id,truck.id]);
            return {status:'IN_PROGRESS',tripId:target.id,replayed:false};
          }
          if(old==='COMPLETED')return {status:'COMPLETED',tripId:target.id,replayed:true};
          if(old!=='IN_PROGRESS')fail(409,'TASK_NOT_STARTED','Start the task before completing');
          if(firstIncomplete?.id!==target.id)fail(409,'SERIAL_ORDER_REQUIRED','Another task is ahead');
          await c.query(`UPDATE aimoc_alfa_ops.truck_task_uat_progress
           SET status='COMPLETED',completed_at=now() WHERE trip_id=$1 AND truck_id=$2`,[target.id,truck.id]);
          return {status:'COMPLETED',tripId:target.id,replayed:false};
        });
        return send(200,{source:'DRIVER_UAT_SIMULATED_PROGRESS',physicalTripStatusChanged:false,
          physicalQrVerified:false,wimVerified:false,...result});
      }
      if(method==='POST'&&path==='/api/login') {
        const body=await parseBody(req);const username=String(body.username||body.email||'').trim().toLowerCase().replace(/@aimoc\.local$/,'').slice(0,80);
        const ip=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0];
        const limitKey=hash(username+'|'+ip);
        const limit=await db.query("INSERT INTO aimoc_alfa_ops.login_limits(key) VALUES($1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limits.window_at<now()-interval '15 minutes' THEN 1 ELSE login_limits.attempts+1 END,window_at=CASE WHEN login_limits.window_at<now()-interval '15 minutes' THEN now() ELSE login_limits.window_at END RETURNING attempts",[limitKey]);
        if(limit.rows[0].attempts>15)fail(429,'TOO_MANY_ATTEMPTS','Terlalu banyak percobaan. Coba lagi dalam 15 menit.');
        const row=(await db.query('SELECT * FROM aimoc_alfa_ops.users WHERE username=$1',[username])).rows[0];
        const correct=await checkPassword(body.password,row?.password_hash);
        if(!row?.active||!correct)fail(401,'INVALID_LOGIN','Username atau password tidak sesuai.');
        const session=token(),csrf=token();
        await db.query("INSERT INTO aimoc_alfa_ops.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",[hash(session),row.id,csrf]);
        await db.query('DELETE FROM aimoc_alfa_ops.login_limits WHERE key=$1',[limitKey]);
        return send(200,{user:userView(row),csrfToken:csrf},{'Set-Cookie':sessionCookie(session,secure)});
      }
      const session=cookieValue(req);
      const auth=session&&(await db.query('SELECT u.*,s.csrf_token FROM aimoc_alfa_ops.sessions s JOIN aimoc_alfa_ops.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true',[hash(session)])).rows[0];
      if(!auth)fail(401,'AUTH_REQUIRED','Silakan login untuk mengakses aplikasi.');
      const actor=userView(auth);
      if(!['GET','HEAD'].includes(method)&&req.headers['x-csrf-token']!==auth.csrf_token)fail(403,'CSRF_REJECTED','Sesi berubah. Muat ulang halaman.');
      if(path==='/api/uat/truck-task-status'){
        if(process.env.AIMOC_LOCAL_TRUCK_CODE_UAT!=='1')
          fail(404,'NOT_FOUND','UAT task status integration is not enabled.');
        if(method!=='GET')fail(405,'METHOD_NOT_ALLOWED','Use GET.');
        if(!['admin','stock','jetty'].includes(actor.role))
          fail(403,'FORBIDDEN_SCOPE','Operational operator role required.');
        const record=(await db.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
        if(!record)fail(503,'NOT_INITIALIZED','Operational snapshot unavailable.');
        const state=record.document;
        const visible=(state.trips||[]).filter(t=>
          actor.role==='admin'||
          (actor.role==='stock'&&(actor.crusherIds||[]).includes(t.crusherId))||
          (actor.role==='jetty'&&(actor.jettyIds||[]).includes(t.jettyId)));
        const ids=visible.map(t=>t.id);
        const [qr,progress]=await Promise.all([
          db.query('SELECT trip_id,truck_id,scanned_at,source FROM aimoc_alfa_ops.truck_qr_uat_events WHERE trip_id=ANY($1::text[])',[ids]),
          db.query('SELECT trip_id,truck_id,status,started_at,completed_at FROM aimoc_alfa_ops.truck_task_uat_progress WHERE trip_id=ANY($1::text[])',[ids])
        ]);
        const scans=new Map(qr.rows.map(x=>[x.trip_id,x]));
        const advances=new Map(progress.rows.map(x=>[x.trip_id,x]));
        return send(200,{source:'UAT_SIMULATED_CROSS_ROLE',operational_status_unchanged:true,
          physical_qr_verified:false,legacy_revision:Number(record.revision),
          items:visible.map(t=>{
            const e=scans.get(t.id),p=advances.get(t.id);
            const truck=(state.trucks||[]).find(x=>x.id===t.truckId);
            return {trip_id:t.id,trip_code:t.code,truck_id:t.truckId,truck_code:truck?.code||null,
              request_id:t.requestId,stockpile_id:t.stockpileId,planned_volume_m3:t.volumeM3??null,
              legacy_status:t.status,qr_uat_scanned:!!e,qr_source:e?.source||null,
              task_uat_status:p?.status||(e?'WAITING':'QR_PENDING'),
              simulated_dump:p?.status==='COMPLETED',
              task_uat_started_at:p?.started_at||null,task_uat_completed_at:p?.completed_at||null};
          })});
      }
      if(path==='/api/uat/truck-qr'){
        if(process.env.AIMOC_LOCAL_TRUCK_CODE_UAT!=='1')
          fail(404,'NOT_FOUND','QR UAT action not enabled');
        if(actor.role!=='admin')fail(403,'FORBIDDEN_SCOPE','Only Admin may simulate a QR scan');
        if(method==='GET'){
          const events=(await db.query('SELECT trip_id,truck_id,source,scanned_at FROM aimoc_alfa_ops.truck_qr_uat_events ORDER BY scanned_at DESC')).rows;
          return send(200,{source:'ADMIN_SIMULATED_QR_UAT',items:events});
        }
        if(method!=='POST')fail(405,'METHOD_NOT_ALLOWED','Use POST');
        const body=await parseBody(req);
        if(!validId(body.tripId)||!validId(body.truckId))
          fail(400,'INVALID_TRIP_TRUCK','Trip and Truck IDs are required.');
        const found=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
        if(!found)fail(503,'NOT_INITIALIZED','Legacy dispatch not available');
        const trip=(found.document.trips||[]).find(t=>t.id===body.tripId);
        if(trip?.source==='INTEGRATED_DEMO')fail(409,'INTEGRATED_WORKFLOW_REQUIRED','Use the integrated QR event action.');
        if(!trip||trip.truckId!==body.truckId||!trip.dispatchId)
          fail(409,'TRIP_TRUCK_MISMATCH','Trip is not assigned to the selected truck.');
        if(['returned','cancelled'].includes(trip.status))
          fail(409,'TRIP_CLOSED','Cannot simulate QR for a closed trip.');
        const existing=(await db.query('SELECT * FROM aimoc_alfa_ops.truck_qr_uat_events WHERE trip_id=$1',
          [trip.id])).rows[0];
        if(existing&&existing.truck_id!==trip.truckId)
          fail(409,'QR_CONFLICT','Trip QR marker is linked to another truck.');
        const accessToken=token();
        const event=existing
          ?(await db.query(`UPDATE aimoc_alfa_ops.truck_qr_uat_events SET access_token_hash=$2,actor_id=$3
             WHERE trip_id=$1 RETURNING trip_id,truck_id,source,scanned_at`,[trip.id,hash(accessToken),actor.id])).rows[0]
          :(await db.query(`INSERT INTO aimoc_alfa_ops.truck_qr_uat_events
             (trip_id,truck_id,actor_id,source,access_token_hash) VALUES($1,$2,$3,'ADMIN_SIMULATED_QR_UAT',$4)
             RETURNING trip_id,truck_id,source,scanned_at`,[trip.id,trip.truckId,actor.id,hash(accessToken)])).rows[0];
        return send(200,{source:'ADMIN_SIMULATED_QR_UAT',status:existing?'TOKEN_ROTATED':'RECORDED',
          physicalScanVerified:false,tripId:trip.id,truckId:trip.truckId,scannedAt:event.scanned_at,
          legacyTripStatus:trip.status,accessToken});
      }
      if(path.startsWith('/api/v1/demo/'))return await handleIntegratedDemo({db,path,method,req,actor,send,parseBody});
      if(method==='GET'&&path==='/api/me')return send(200,{user:actor,csrfToken:auth.csrf_token});
      if(method==='GET'&&path==='/api/capabilities'){
        const permissions=permissionsForRole(actor.role);
        return send(200,{source:'LEGACY_AUTHORIZATION',role:actor.role,permissions,
          locationScope:{crusherIds:actor.crusherIds||[],jettyIds:actor.jettyIds||[]},
          features:actor.role==='admin'?TARGET_ADMIN_CAPABILITIES:[],
          targetWritesEnabled:false,driverProductionIntegrated:false,integratedDemoEnabled:true,integratedDemoSource:'INTEGRATED_DEMO'});
      }

      if(method==='POST'&&path==='/api/logout'){await db.query('DELETE FROM aimoc_alfa_ops.sessions WHERE token_hash=$1',[hash(session)]);return send(200,{ok:true},{'Set-Cookie':sessionCookie('',secure,0)});}
      // Local-only separate location master. Existing operational JSON and
      // production normalized schemas remain untouched. The table is created
      // explicitly by local.mjs, NOT by production application startup.
      if(path==='/api/crusher-loading-points'&&['GET','POST'].includes(method)){
        if(actor.role!=='admin')fail(403,'FORBIDDEN_SCOPE','Only Admin manages Crusher Location Master.');
        if(method==='GET')return send(200,{source:'LOCAL_LOCATION_MASTER',items:await listCrusherLoadingPoints(db)});
        const body=await parseBody(req);
        const row=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];
        if(!row)fail(503,'NOT_INITIALIZED','Master data not initialized.');
        const crusherIds=(row.document.crushers||[]).filter(x=>x.active!==false).map(x=>x.id);
        const saved=await saveCrusherLoadingPoint(db,{actorId:actor.id,body,crusherIds});
        return send(200,{source:'LOCAL_LOCATION_MASTER',item:saved});
      }
      // Local Driver UAT can authenticate to inspect the data-free shell only.
      // Never expose an unscoped legacy operation snapshot to this role.
      if(actor.role==='driver'){
        if(method==='GET'&&path==='/api/v1/session')
          return send(200,{schema_version:'1.0',resource:'session',source:'LOCAL_UAT',
            data_status:'NOT_INTEGRATED',as_of:null,
            data:{user_id:actor.id,role:'DRIVER',display_name:actor.displayName,
              location_scope:{crusher_ids:[],jetty_ids:[]},permissions:[]}});
        if(method==='GET'&&path.startsWith('/api/v1/driver/'))
          return send(200,{schema_version:'1.0',resource:'driver_trip',source:'NOT_INTEGRATED',
            data_status:'NOT_INTEGRATED',as_of:null,reason:'Driver operational integration pending',data:null});
        if(!['GET','HEAD'].includes(method)&&path.startsWith('/api/v1/'))
          fail(501,'V1_COMMAND_NOT_INTEGRATED','Driver write commands are not active.');
        fail(403,'FORBIDDEN_SCOPE','Driver UAT cannot access legacy operational data.');
      }
      const view=async c=>{const row=(await c.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];if(!row)fail(503,'NOT_INITIALIZED','Aplikasi belum diinisialisasi.');return {state:publicState(row.document,actor),revision:Number(row.revision),updatedAt:row.updated_at,serverTime:new Date().toISOString()};};
      if(method==='GET'&&path.startsWith('/api/v1/')) {
        // Authenticate and filter the legacy operation first. No unscoped rows
        // may cross the v1 read boundary.
        const v=await view(db);
        const projected=projectV1Read(path,v,actor,url.searchParams);
        if(projected)return send(200,projected);
        fail(404,'RESOURCE_NOT_FOUND','Endpoint API v1 tidak tersedia.');
      }
      if(isV1UnimplementedMutation(path,method)) {
        // Never translate a target-v1 business command into a legacy mutation:
        // especially not marine sequence, inventory departure, unload or WIM.
        fail(501,'V1_COMMAND_NOT_INTEGRATED','Perintah API v1 belum terintegrasi dengan domain transaksi dan bukti verifikasi. Tidak ada perubahan yang disimpan.');
      }
      if(method==='GET'&&path==='/api/state')return send(200,await view(db));
      if(method==='POST'&&path==='/api/action') {
        const body=await parseBody(req);
        if(!validId(body.requestId)||typeof body.action!=='string')fail(400,'INVALID_ACTION','Identitas aksi tidak valid.');
        const decision=authorizeLegacyAction(actor.role,body.action);
        if(!decision.allowed)fail(403,'PERMISSION_DENIED','Aksi tidak diizinkan untuk role ini atau belum terintegrasi.');

        const payload=body.payload||{};const payloadHash=hash(JSON.stringify([body.action,payload]));
        const result=await db.transaction(async c=>{
          const locked=(await c.query('SELECT document,revision FROM aimoc_alfa_ops.operation WHERE id=1 FOR UPDATE')).rows[0];
          if(!locked)fail(503,'NOT_INITIALIZED','Aplikasi belum diinisialisasi.');
          const previous=(await c.query('SELECT payload_hash,result FROM aimoc_alfa_ops.actions WHERE actor_id=$1 AND request_id=$2',[actor.id,body.requestId])).rows[0];
          if(previous){if(previous.payload_hash!==payloadHash)fail(409,'IDEMPOTENCY_CONFLICT','ID aksi sudah dipakai untuk permintaan lain.');return {...await view(c),result:previous.result,replayed:true};}
          if(body.expectedRevision!==undefined&&Number(body.expectedRevision)!==Number(locked.revision))fail(409,'REVISION_CONFLICT','Data diperbarui operator lain. Muat ulang sebelum menyimpan.');
          if(body.action==='measurement.create'){
            payload.evidenceId=payload.evidenceId||payload.evidence?.id;
            if(payload.evidenceId){
              const evidence=(await c.query('SELECT actor_id,filename FROM aimoc_alfa_ops.evidence WHERE id=$1',[payload.evidenceId])).rows[0];
              if(!evidence||evidence.actor_id!==actor.id)fail(403,'EVIDENCE_ACCESS','Pengukuran hanya dapat memakai bukti unggahan operator sendiri.');
              payload.evidenceName=evidence.filename;
            }
            if(payload.method==='camera_pending'&&!payload.evidenceId)fail(400,'EVIDENCE_REQUIRED','Unggah foto sebelum menyimpan bukti kamera.');
          }
          const state=structuredClone(locked.document);
          guardLegacyIntegratedMutation(state,body.action,payload);
          const actionResult=applyAction(state,body.action,payload,actor)||{message:'Tersimpan'};
          await c.query('UPDATE aimoc_alfa_ops.operation SET document=$1::jsonb,revision=revision+1,updated_at=now() WHERE id=1',[JSON.stringify(state)]);
          await c.query('INSERT INTO aimoc_alfa_ops.actions(actor_id,request_id,payload_hash,result) VALUES($1,$2,$3,$4::jsonb)',[actor.id,body.requestId,payloadHash,JSON.stringify(actionResult)]);
          return {...await view(c),result:actionResult};
        });return send(200,result);
      }
      if(path==='/api/users'){
        if(actor.role!=='admin')fail(403,'ROLE_REQUIRED','Hanya Admin AIMOC.');
        if(method==='GET')return send(200,{users:(await db.query('SELECT * FROM aimoc_alfa_ops.users ORDER BY created_at')).rows.map(userView)});
        if(method==='POST'){
          const b=await parseBody(req);const username=String(b.username||'').trim().toLowerCase().replace(/@aimoc\.local$/,'');
          if(!/^[a-z0-9._-]{3,60}$/.test(username)||!['admin','stock','jetty','driver'].includes(b.role)||!b.displayName?.trim())fail(400,'INVALID_USER','Lengkapi username, nama, dan peran.');
          const crusherIds=Array.isArray(b.crusherIds)?b.crusherIds.filter(validId):[],jettyIds=Array.isArray(b.jettyIds)?b.jettyIds.filter(validId):[];
          if((b.role==='stock'&&!crusherIds.length)||(b.role==='jetty'&&!jettyIds.length))fail(400,'USER_SCOPE','Tentukan lokasi operator.');
          const masters=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
          if(crusherIds.some(id=>!masters.crushers.some(c=>c.id===id&&c.active))||jettyIds.some(id=>!masters.jetties.some(j=>j.id===id&&j.active)))fail(400,'USER_SCOPE','Lokasi operator tidak terdaftar atau tidak aktif.');
          const id=randomUUID(),encoded=await passwordHash(b.password);
          const row=(await db.query('INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role,crusher_ids,jetty_ids) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,username,b.displayName.trim().slice(0,100),encoded,b.role,crusherIds,jettyIds])).rows[0];return send(201,{user:userView(row)});
        }
      }
      if(path==='/api/evidence'&&method==='POST'){
        if(actor.role!=='stock')fail(403,'ROLE_REQUIRED','Hanya operator Stockpile yang dapat mengunggah bukti pengukuran.');
        const b=await parseBody(req);const match=/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl||''));
        if(!match)fail(400,'IMAGE_REQUIRED','Gunakan foto JPEG atau PNG.');
        const bytes=Buffer.from(match[2],'base64');const isJpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;const isPng=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        if(!bytes.length||bytes.length>2097152)fail(413,'IMAGE_SIZE','Foto maksimal 2 MiB.');
        if((match[1]==='image/jpeg'&&!isJpeg)||(match[1]==='image/png'&&!isPng))fail(400,'INVALID_IMAGE','Isi foto tidak sesuai format.');
        const id=randomUUID(),sha256=hash(bytes);const name=String(b.name||'stockpile.jpg').replace(/[^a-zA-Z0-9_.-]/g,'_').slice(0,100);
        await db.transaction(async c=>{
          await c.query('SELECT id FROM aimoc_alfa_ops.operation WHERE id=1 FOR UPDATE');
          const used=(await c.query('SELECT count(*)::int AS count,COALESCE(sum(size),0)::bigint AS bytes FROM aimoc_alfa_ops.evidence')).rows[0];
          if(used.count>=200||Number(used.bytes)+bytes.length>150000000)fail(409,'EVIDENCE_QUOTA','Penyimpanan foto prototipe penuh. Hubungi Admin.');
          await c.query('INSERT INTO aimoc_alfa_ops.evidence(id,actor_id,content,content_type,filename,sha256,size) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,actor.id,bytes,match[1],name,sha256,bytes.length]);
        });return send(201,{id,url:'/api/evidence/'+id,sha256,mimeType:match[1],size:bytes.length});
      }
      if(method==='GET'&&path.startsWith('/api/evidence/')){
        const id=path.split('/').pop();if(!validId(id))fail(404,'NOT_FOUND','Bukti tidak ditemukan.');
        const row=(await db.query('SELECT * FROM aimoc_alfa_ops.evidence WHERE id=$1',[id])).rows[0];
        if(!row)fail(404,'NOT_FOUND','Bukti tidak ditemukan.');
        if(actor.role!=='admin'&&row.actor_id!==actor.id){const state=(await view(db)).state;if(!state.measurements?.some(m=>m.evidenceId===id))fail(403,'EVIDENCE_ACCESS','Bukti di luar lokasi penugasan Anda.');}
        res.writeHead(200,{'Content-Type':row.content_type,'Content-Length':row.size,'Cache-Control':'private, max-age=60','Content-Security-Policy':"default-src 'none'; sandbox",'X-Content-Type-Options':'nosniff'});return res.end(Buffer.from(row.content));
      }
      fail(404,'NOT_FOUND','Layanan tidak ditemukan.');
    } catch(error) {
      const status=error.status||error.statusCode||500;
      if(error.code==='23505')return send(409,{error:'DUPLICATE',message:'Kode atau username sudah terdaftar.'});
      if(error.code==='23514'&&error.constraint==='users_role_check')return send(503,{error:'SCHEMA_MIGRATION_REQUIRED',message:'Database perlu migrasi role Driver melalui setup Admin sebelum akun dapat dibuat.'});
      if(error.code==='42P01'||error.code==='ECONNREFUSED')return send(503,{error:'DATABASE_UNAVAILABLE',message:'Penyimpanan tidak tersedia.'});
      return send(status,{error:error.code||'REQUEST_REJECTED',message:status<500?String(error.message||'Permintaan ditolak.').slice(0,250):'Proses belum berhasil. Silakan muat ulang.'});
    }
  };
}
