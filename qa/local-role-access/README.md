# AIMOC — Local UAT Login Access

The **local embedded database** now has seven valid credentials. This is for localhost only.

| Role | Local username | Password source | Visible area |
| --- | --- | --- | --- |
| Admin | admin | \`.local/access.json\` | Admin desktop |
| Stockpile | stock1 | \`.local/access.json\` | Stockpile mobile, location 1 |
| Stockpile | stock2 | \`.local/access.json\` | Stockpile mobile, location 2 |
| Legacy Jetty | jetty1 | \`.local/access.json\` | Legacy jetty workflow, location 1 |
| Legacy Jetty | jetty2 | \`.local/access.json\` | Legacy jetty workflow, location 2 |
| Driver UAT | driver1 | \`.local/driver-access.json\` | Data-free Driver mobile shell |
| Driver UAT | driver2 | \`.local/driver-access.json\` | Data-free Driver mobile shell |

The two Driver accounts are created by \`scripts/local-driver-uat.mjs\`, run
only when \`scripts/local.mjs\` chooses local embedded PGlite, with no
\`DATABASE_URL\`. The script is idempotent: it never resets existing Driver
passwords. The separate access file is ignored by Git and saved with
permissions 0600.

**Driver access is strictly UI-only for UAT.** The session can access
\`/api/me\` and a NOT_INTEGRATED Driver target response, but cannot read
\`/api/state\`, use \`/api/action\`, access other role endpoints, or perform
Phase 4B transactions. External Weighbridge authentication is machine-to-machine,
not a role login.

From the repository root:
\`\`\`bash
npm run dev
\`\`\`
Open \`http://127.0.0.1:4196\` and use the corresponding username/password.

To view credentials privately without copying them into chat:
\`\`\`bash
cat .local/access.json
cat .local/driver-access.json
\`\`\`

For Stockpile and Driver layouts, use a mobile browser or Chrome DevTools
device toolbar at 390px width. Log out before switching roles, or use
different browser profiles.

Caution: the primary account schema is NOT changed in the deployable
\`server/schema.sql\`. An explicit local-only constraint is adjusted in
the embedded database. The current production database and Vercel deployment
are not touched. Driver production identity and operational API integration
remain Phase 4C work.
