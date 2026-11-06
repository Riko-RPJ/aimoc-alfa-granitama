#!/bin/bash
set -eo pipefail
if test -n "$DATABASE_URL"; then
  echo "REFUSED: DATABASE_URL set; isolated local only" >&2
  exit 8
fi
for c in node psql createdb dropdb pg_dump pg_restore openssl; do
  command -v "$c" >/dev/null || { echo "Missing $c" >&2; exit 9; }
done
LOCAL="$(psql -XAt -d postgres -c 'SELECT inet_server_addr() IS NULL' 2>/dev/null || true)"
if test "$LOCAL" != "t"; then
  echo "REFUSED: database not reached by local socket" >&2
  exit 10
fi
SOURCE="aimoc_rehearsal_$(openssl rand -hex 6)"
RESTORE="aimoc_rehearsal_$(openssl rand -hex 6)"
DUMP="$(mktemp /tmp/aimoc-p4d-backup.XXXXXX.dump)"
cleanup() {
  dropdb --if-exists "$RESTORE" >/dev/null 2>&1 || true
  dropdb --if-exists "$SOURCE" >/dev/null 2>&1 || true
  rm -f "$DUMP"
}
trap cleanup EXIT
createdb "$SOURCE"
createdb "$RESTORE"
AIMOC_REHEARSAL_DB="$SOURCE" node --input-type=module - <<'JS'
import {runConcurrencyRehearsal} from './server/v1/rehearsal-concurrency.mjs';
const result=await runConcurrencyRehearsal({databaseName:process.env.AIMOC_REHEARSAL_DB});
const {db,...summary}=result;
console.log('CONCURRENCY='+JSON.stringify(summary));
JS
pg_dump -Fc -f "$DUMP" "$SOURCE"
pg_restore --no-owner --no-privileges -d "$RESTORE" "$DUMP"
QUERY="SELECT json_build_object(
  'trips',(SELECT md5(coalesce(string_agg(id||':'||status,',' ORDER BY id),'')) FROM aimoc_execution_v1.trips),
  'gates',(SELECT md5(coalesce(string_agg(dispatch_id||':'||coalesce(active_trip_id,'none'),',' ORDER BY dispatch_id),'')) FROM aimoc_execution_v1.marine_gates),
  'claims',(SELECT count(*) FROM aimoc_execution_v1.resource_claims),
  'events',(SELECT count(*) FROM aimoc_execution_v1.operational_events),
  'reservations',(SELECT count(*) FROM aimoc_execution_v1.inventory_reservations),
  'accounts',(SELECT md5(coalesce(string_agg(location_id||':'||sku_id||':'||on_hand_t||':'||reserved_t,',' ORDER BY location_id,sku_id),'')) FROM aimoc_execution_v1.inventory_accounts),
  'tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='aimoc_execution_v1'),
  'triggers',(SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='aimoc_execution_v1' AND NOT t.tgisinternal))"
SRC="$(psql -XAt -d "$SOURCE" -c "$QUERY")"
DST="$(psql -XAt -d "$RESTORE" -c "$QUERY")"
if test "$SRC" != "$DST"; then
  echo "FAIL backup/restore mismatch" >&2
  exit 11
fi
echo "BACKUP_RESTORE=PASS"
echo "RECONCILIATION=$DST"
echo "CLEANUP=automatic"
