#!/bin/bash
set -eo pipefail
if test -n "$DATABASE_URL";then echo "REFUSED: DATABASE_URL is set" >&2;exit 8;fi
if test "$(psql -XAt -d postgres -c 'SELECT inet_server_addr() IS NULL')" != 't';then
 echo "REFUSED: local PostgreSQL socket only" >&2;exit 9
fi
DB="aimoc_rehearsal_$(openssl rand -hex 6)"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT
createdb "$DB"
AIMOC_REHEARSAL_DB="$DB" node scripts/phase4g-pg-contract-rehearsal.mjs
echo "TEMPORARY_DATABASE_CLEANUP=AUTOMATIC"
