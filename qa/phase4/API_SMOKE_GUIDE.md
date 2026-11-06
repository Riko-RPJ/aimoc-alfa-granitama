# Testing the new read-only API v1 locally

1. From the repository root, run `npm run dev`. The complete legacy + v1 backend normally listens on http://127.0.0.1:4196.
2. Log in using an existing local account, with the password found in the private `.local/access.json` file; never publish credentials.
3. Open `http://127.0.0.1:4196/api/v1/session` in the same browser session.
4. For Admin, inspect `/api/v1/operations/overview`, `/api/v1/dispatches`, `/api/v1/master-data`, `/api/v1/inventory`.
5. For Stockpile, inspect `/api/v1/inventory` and `/api/v1/stockpile/me/pickups`.
6. Observe that actual verified tonnage and Marine Sequence Eligibility are NULL where legacy sources cannot establish them.

Important: /api/v1 read-only endpoints do not enable new target operations. Do not send writes expecting Marine Opsi B, Driver assignment or verified weighbridge events. They intentionally return HTTP 501.
