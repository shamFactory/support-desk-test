# Handoff

## Changes and ownership

Completed. The starter left webhook replay, tenant checks, approval, delivery, and takeover incomplete. Those paths are now enforced on the server.

- Inbound events are idempotent per organization. The event row and the customer message commit together. A replay, including overlapping writers, does not add a second message. An existing database is backfilled so events stored before that table existed are not replayed after upgrade.
- Ticket access uses the bearer token’s organization. Guessing another ticket id, or sending another `tenantId` in the body, returns 404 and does not read or change that ticket.
- A send requires the current saved draft to be explicitly approved. Saving again clears that approval. One approved version is claimed in SQLite before the provider is called, so a repeat click, an overlap, or a restart does not send it twice.
- A timeout or any non-rejection failure stays `UNKNOWN` with a `clientRef`. It is not called sent and it is not resent. Check delivery looks up that same reference. `delivered` plus a provider id becomes `SENT`. `not_found` and a failed lookup stay uncertain. An HTTP 503 before acceptance is `FAILED`; only a new approved draft can be sent.
- After takeover, automation is refused. A human can still send an approved reply. The audit names the sender (`agent-alpha: …` or `automation: …`).
- The inbox shows conversation, owner, approval, delivery, audit, and the next safe action. Customer text is rendered as text.

The code is split into SQLite connection and schema, one repository per table, a delivery policy, and webhook, ticket, and delivery services behind `DeskService`. Docker runs Node 24 with the desk and mock provider on separate data directories, published only on `127.0.0.1`.

Not done, and not proposed as finished work: real GHL OAuth, production auth, a retry scheduler, or multi-process deployment.

## Verification

The app needs Node.js 24 or newer. No `npm install` is required. Install Node 24 and run it directly, or use Docker, which already provides Node 24.

Without Docker, from this directory, in two terminals:

```powershell
npm run provider
npm start
```

Then open `http://127.0.0.1:4300`. In a third terminal, `npm test` runs the suite and `npm run event` replays an inbound webhook.

With Docker:

```powershell
docker compose build
docker compose up -d
docker compose run --rm desk npm test
```

The desk is at `http://127.0.0.1:4300` and the mock provider at `http://127.0.0.1:4301`. Stop with `docker compose down`.

`npm test` result: 25 passed, 0 failed. The suite includes `test/workflow.test.mjs`, `test/http.test.mjs`, `test/migration.test.mjs`, and `test/smoke.test.mjs`.

Example of a test that fails on the original defect and passes after the fix: `replaying one organization event stores a single customer message`. The starter inserted a second row with the replay body. After the fix the ticket keeps only `Please help` and one `inbound` audit row. The same run covers isolation, exact approval, one send under overlap, `UNKNOWN` across restart, reconcile without a second send, `not_found`, explicit rejection, and takeover.

Also checked by hand against the running containers: automation send audited as `automation: …`, a later human send as `agent-alpha: …`, a provider timeout left `UNKNOWN` and then reconciled to `SENT`, and a restart still showed that ticket. In the browser, Alpha showed ticket 101 with the next action and an `<img …>` body as text; Beta’s inbox showed only ticket 202.

## Operator instructions

`UNKNOWN` means a send was recorded and the provider did not confirm it. The message may already have been delivered.

Check delivery. Do not send again, do not edit-and-resend that same text, and do not treat `not_found` as proof it failed. If the provider confirms the same attempt, the ticket becomes `SENT` and nothing is sent again. If the check itself fails, the attempt stays `UNKNOWN`.

After a restart the attempt is still there, so the app will not send that version again. A `FAILED` state is different: the provider rejected the attempt before accepting it. Save a new draft, approve that exact text, then send.

## Remaining risks and production plan

This is not production-ready. Fixture bearer tokens and one webhook secret are intentional. The mock provider has no authentication and must stay on loopback. There is one Node process, one SQLite file, no foreign keys, and no retry scheduler. Unexpected errors return a generic 502; the real message is only in the server log. Two containers no longer share one data directory, but SQLite is still a single-writer local file.

Before a real GHL pilot: confirm OAuth and per-tenant webhook signatures; map GHL’s accept, timeout, and not-found responses onto `SENT`, `UNKNOWN`, and `FAILED` without a blind retry; send one canary with a known `clientRef` and reconcile it from GHL’s ledger; alert on `UNKNOWN` older than a few minutes; roll back by stopping automation (takeover already blocks new automatic sends) and keeping the SQLite file for reconciliation. Do not cut over until a timeout in GHL is shown as uncertain rather than sent.

## AI use and time

Cursor agent (Grok) wrote and revised the implementation, tests, Docker setup, and this note. Docker and `node --test` were used to run it.

Accepted: keep the servers on `127.0.0.1` by default and set `LISTEN_HOST=0.0.0.0` only in Compose, with host ports bound to `127.0.0.1`. Verified by opening the desk and provider from the host and by the HTTP tests.

Rejected: `npm install` in the image. `package.json` has no dependencies; `npm test` passes with none installed. Also left the fixture auth scheme in place because the contract says not to replace it.

Approximate time: about 2 hours of agent-assisted work on 1–2 Nov 2026, including setup, implementation, review, and the split into smaller modules.
