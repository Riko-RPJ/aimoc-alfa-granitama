# AIMOC Admin Role Alignment — implementation record

Date: 2026-11-06. Branch: refactor/phase1-design-system-extraction.

## Scope implemented
- Added Admin navigation route /admin/access-control (legacy shell).
- Added Role & Access Control workspace consistent with Navy/Teal AIMOC theme.
- Current admin legacy page links and explicit not-integrated target capabilities.
- Role-based legacy permission catalog shared by browser and backend module.
- Added GET /api/capabilities returning authenticated actor grants, scope and targetWritesEnabled=false.
- Added permission authorization at /api/action BEFORE any legacy transaction; unknown/unintegrated actions fail 403.
- Frontend prevents known disallowed legacy actions before sending them and shows feedback.
- Existing legacy Admin/Jetty/Stockpile workflows preserved, including Admin start/depart/return compatibility, Jetty receiving and request creation, and Admin master/plan.
- Sensitive physical event / v1 proof not invented; actual v1 mutation endpoints remain unavailable.
- Added tests/admin-access-enforcement.test.mjs for cross-role grants, backend endpoint and denied actions.

## Limitations / explicit mismatch with target architecture
- The historical legacy API permits Admin to start/depart/return trips, without physical vendor proof. This was preserved to avoid disrupting running local simulations; it is NOT final separation-of-duties.
- New v1 destination allocation, Driver production assignment, WIM hardware ingestion, inventory tonnes reconciliation and exceptions remain NOT_INTEGRATED.
- Role matrix for existing users is determined by role plus location-scope; target permission delegation and per-user feature overrides are not active.
- This work is not a wholesale Admin screen redesign and does not activate target DTOs.
- Capability display is declarative; backend authorization remains authoritative for writes.

## User walkthrough
1. Run npm run dev from repository root.
2. Open http://127.0.0.1:4196 and sign in as admin.
3. Sidebar: Role & Access Control.
4. Review live legacy features and in-progress target modules. Use Open module to navigate an existing screen.
5. Switch to stock1 or jetty1; role-specific sidebar omits Admin access page. Backend enforces permission on actions.
6. Do not treat the target "Not integrated" entries as available transactions.

## Operational safety
No production database schema changed, no destructive data reset, no Git commit/push, no Vercel deployment.
