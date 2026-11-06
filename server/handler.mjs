import {randomUUID} from 'node:crypto';
import {hash,token,passwordHash,checkPassword,userView,cookieValue,sessionCookie} from './auth.mjs';
import {applyAction,publicState} from './domain.mjs';

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
      if(method==='GET'&&path==='/api/me')return send(200,{user:actor,csrfToken:auth.csrf_token});
      if(method==='POST'&&path==='/api/logout'){await db.query('DELETE FROM aimoc_alfa_ops.sessions WHERE token_hash=$1',[hash(session)]);return send(200,{ok:true},{'Set-Cookie':sessionCookie('',secure,0)});}
      const view=async c=>{const row=(await c.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0];if(!row)fail(503,'NOT_INITIALIZED','Aplikasi belum diinisialisasi.');return {state:publicState(row.document,actor),revision:Number(row.revision),updatedAt:row.updated_at,serverTime:new Date().toISOString()};};
      if(method==='GET'&&path==='/api/state')return send(200,await view(db));
      if(method==='POST'&&path==='/api/action') {
        const body=await parseBody(req);
        if(!validId(body.requestId)||typeof body.action!=='string')fail(400,'INVALID_ACTION','Identitas aksi tidak valid.');
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
              if(!evidence||(evidence.actor_id!==actor.id&&actor.role!=='admin'))fail(403,'EVIDENCE_ACCESS','Bukti pengukuran tidak dapat diakses.');
              payload.evidenceName=evidence.filename;
            }
            if(payload.method==='camera_pending'&&!payload.evidenceId)fail(400,'EVIDENCE_REQUIRED','Unggah foto sebelum menyimpan bukti kamera.');
          }
          const state=structuredClone(locked.document);
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
          if(!/^[a-z0-9._-]{3,60}$/.test(username)||!['admin','stock','jetty'].includes(b.role)||!b.displayName?.trim())fail(400,'INVALID_USER','Lengkapi username, nama, dan peran.');
          const crusherIds=Array.isArray(b.crusherIds)?b.crusherIds.filter(validId):[],jettyIds=Array.isArray(b.jettyIds)?b.jettyIds.filter(validId):[];
          if((b.role==='stock'&&!crusherIds.length)||(b.role==='jetty'&&!jettyIds.length))fail(400,'USER_SCOPE','Tentukan lokasi operator.');
          const masters=(await db.query('SELECT document FROM aimoc_alfa_ops.operation WHERE id=1')).rows[0].document;
          if(crusherIds.some(id=>!masters.crushers.some(c=>c.id===id&&c.active))||jettyIds.some(id=>!masters.jetties.some(j=>j.id===id&&j.active)))fail(400,'USER_SCOPE','Lokasi operator tidak terdaftar atau tidak aktif.');
          const id=randomUUID(),encoded=await passwordHash(b.password);
          const row=(await db.query('INSERT INTO aimoc_alfa_ops.users(id,username,display_name,password_hash,role,crusher_ids,jetty_ids) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,username,b.displayName.trim().slice(0,100),encoded,b.role,crusherIds,jettyIds])).rows[0];return send(201,{user:userView(row)});
        }
      }
      if(path==='/api/evidence'&&method==='POST'){
        if(!['stock','admin'].includes(actor.role))fail(403,'ROLE_REQUIRED','Hanya operator stockpile dan Admin.');
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
      if(error.code==='42P01'||error.code==='ECONNREFUSED')return send(503,{error:'DATABASE_UNAVAILABLE',message:'Penyimpanan tidak tersedia.'});
      return send(status,{error:error.code||'REQUEST_REJECTED',message:status<500?String(error.message||'Permintaan ditolak.').slice(0,250):'Proses belum berhasil. Silakan muat ulang.'});
    }
  };
}
