/**
 * Local-only UAT QR acceptance marker. This is NOT a physical QR scanner event.
 * Kept outside legacy operational state to avoid fabricating trip milestones.
 */
export async function installLocalTruckQrUat(db) {
 if(process.env.AIMOC_LOCAL_TRUCK_CODE_UAT!=='1'||process.env.DATABASE_URL)
  throw new Error('LOCAL_UAT_QR_SCHEMA_REQUIRES_EXPLICIT_OPT_IN');
 await db.query(`CREATE TABLE IF NOT EXISTS aimoc_alfa_ops.truck_qr_uat_events (
  trip_id text PRIMARY KEY,
  truck_id text NOT NULL,
  actor_id text NOT NULL,
  access_token_hash text,
  source text NOT NULL CHECK (source = 'ADMIN_SIMULATED_QR_UAT'),
  scanned_at timestamptz NOT NULL DEFAULT now()
 )`);
 await db.query('ALTER TABLE aimoc_alfa_ops.truck_qr_uat_events ADD COLUMN IF NOT EXISTS access_token_hash text');
 await db.query(`CREATE TABLE IF NOT EXISTS aimoc_alfa_ops.truck_task_uat_progress (
  trip_id text PRIMARY KEY,
  truck_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('IN_PROGRESS','COMPLETED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT truck_task_uat_completed_check CHECK(
   (status='IN_PROGRESS' AND completed_at IS NULL) OR
   (status='COMPLETED' AND completed_at IS NOT NULL))
 )`);
}
