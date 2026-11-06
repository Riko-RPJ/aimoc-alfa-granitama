import {randomUUID} from 'node:crypto';
const invalid=(code,message,status=400)=>{throw Object.assign(new Error(message),{status,code});};
const codeRe=/^[A-Za-z0-9_-]{2,60}$/;
const text=(value,max=120)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max;
const numeric=v=>v===null||v===undefined||v===''?null:Number(v);
export function validateCrusherLocation(input,existingCrusherIds=[]){
 if(!input||typeof input!=='object'||Array.isArray(input))invalid('INVALID_LOCATION','Objek lokasi diperlukan.');
 const allowed=new Set(['crusher_id','zone','loading_point_id','loading_point_name','latitude','longitude','access_notes','evidence_ref']);
 if(Object.keys(input).some(k=>!allowed.has(k)))invalid('UNKNOWN_LOCATION_FIELD','Field lokasi tidak dikenal.');
 const crusherId=input.crusher_id,pointId=input.loading_point_id;
 if(!codeRe.test(crusherId||'')||!codeRe.test(pointId||'')||!text(input.loading_point_name)||!text(input.zone,80))
   invalid('LOCATION_FIELDS_REQUIRED','Crusher, loading point, zona dan nama titik wajib valid.');
 if(!existingCrusherIds.includes(crusherId))invalid('UNKNOWN_CRUSHER','Crusher harus ada di Master Data.');
 const lat=numeric(input.latitude),lon=numeric(input.longitude);
 if((lat===null)!==(lon===null))invalid('COORDINATES_INCOMPLETE','Latitude dan longitude harus tersedia berpasangan.');
 if(lat!==null&&(!Number.isFinite(lat)||!Number.isFinite(lon)||lat < -90||lat > 90||lon < -180||lon > 180))
   invalid('COORDINATES_INVALID','Koordinat tidak valid.');
 if(input.access_notes!=null&&(typeof input.access_notes!=='string'||input.access_notes.length>500))
   invalid('ACCESS_NOTES_INVALID','Catatan akses terlalu panjang.');
 if(input.evidence_ref!=null&&(typeof input.evidence_ref!=='string'||input.evidence_ref.length>160))
   invalid('EVIDENCE_REF_INVALID','Referensi bukti tidak valid.');
 return {crusher_id:crusherId,zone:input.zone.trim(),loading_point_id:pointId,
  loading_point_name:input.loading_point_name.trim(),latitude:lat,longitude:lon,
  access_notes:input.access_notes?.trim()||null,evidence_ref:input.evidence_ref?.trim()||null};
}
export async function installLocalCrusherLocationMaster(db){
 await db.query(`CREATE TABLE IF NOT EXISTS aimoc_alfa_ops.crusher_loading_points (
   id text PRIMARY KEY,crusher_id text NOT NULL,zone text NOT NULL,
   loading_point_id text NOT NULL UNIQUE,loading_point_name text NOT NULL,
   latitude double precision,longitude double precision,
   access_notes text,evidence_ref text,
   verification_status text NOT NULL DEFAULT 'UNVERIFIED'
      CHECK (verification_status IN ('UNVERIFIED','PENDING_REVIEW')),
   revision integer NOT NULL DEFAULT 1,
   created_by text NOT NULL,updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
   CHECK ((latitude IS NULL AND longitude IS NULL) OR
    (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))
 )`);
}
export async function listCrusherLoadingPoints(db){
 const {rows}=await db.query(`SELECT id,crusher_id,zone,loading_point_id,loading_point_name,latitude,longitude,
  access_notes,evidence_ref,verification_status,revision,updated_at
  FROM aimoc_alfa_ops.crusher_loading_points ORDER BY crusher_id,loading_point_id`);
 return rows;
}
export async function saveCrusherLoadingPoint(db,{actorId,body,crusherIds}){
 if(!actorId)invalid('AUTH_REQUIRED','Admin required.',401);
 const v=validateCrusherLocation(body,crusherIds);
 return db.transaction(async c=>{
  const existing=(await c.query('SELECT id FROM aimoc_alfa_ops.crusher_loading_points WHERE loading_point_id=$1 FOR UPDATE',[v.loading_point_id])).rows[0];
  const id=existing?.id??randomUUID();
  const values=[id,v.crusher_id,v.zone,v.loading_point_id,v.loading_point_name,
   v.latitude,v.longitude,v.access_notes,v.evidence_ref,actorId];
  const {rows}=await c.query(`INSERT INTO aimoc_alfa_ops.crusher_loading_points
   (id,crusher_id,zone,loading_point_id,loading_point_name,latitude,longitude,access_notes,evidence_ref,
    created_by,updated_by)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
   ON CONFLICT (loading_point_id) DO UPDATE SET
    crusher_id=EXCLUDED.crusher_id,zone=EXCLUDED.zone,loading_point_name=EXCLUDED.loading_point_name,
    latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,access_notes=EXCLUDED.access_notes,
    evidence_ref=EXCLUDED.evidence_ref,verification_status='UNVERIFIED',
    revision=crusher_loading_points.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now()
   RETURNING id,crusher_id,zone,loading_point_id,loading_point_name,latitude,longitude,
    access_notes,evidence_ref,verification_status,revision,updated_at`,values);
  return rows[0];
 });
}
