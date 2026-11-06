# Phase 4B isolated staging validation

From the repository root:
```bash
npm run build
node --test tests/v1-phase4b-integration.test.mjs tests/v1-phase4b-safety.test.mjs
npm test
git diff --check
```

Each integration test creates its own in-memory PostgreSQL/PGlite database, explicitly invokes `createIsolatedExecutionSchema()` followed by `extendIsolatedExecutionSchema()`, inserts only QA fixtures, and closes the database afterward.

**Do not run `server/v1/execution-phase4b.sql` directly on the legacy `aimoc_alfa_ops` production database or your persistent local `.local/database`.** The schema is a staging implementation candidate, not an approved migration.

The normal app still starts with `npm run dev` and uses its original login/accounts and legacy workflows. The new Driver UI shell can be reviewed as before, but Driver login and the v1 mutation endpoints remain unavailable pending backend deployment.
