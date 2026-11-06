#!/bin/bash
set -eo pipefail
if test -n "$DATABASE_URL"; then echo "REFUSED: production DATABASE_URL is present" >&2; exit 8; fi
if test "$(psql -XAt -d postgres -c 'SELECT inet_server_addr() IS NULL')" != "t"; then
 echo "REFUSED: local socket required" >&2; exit 9
fi
DB="aimoc_rehearsal_$(openssl rand -hex 6)"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT
createdb "$DB"
AIMOC_REHEARSAL_DB="$DB" node --input-type=module - <<'JS'
import {runPhase4ERehearsal} from './server/v1/rehearsal-phase4e.mjs';
console.log(JSON.stringify(await runPhase4ERehearsal(process.env.AIMOC_REHEARSAL_DB),null,2));
JS
echo "CLEANUP=automatic temporary DB"
