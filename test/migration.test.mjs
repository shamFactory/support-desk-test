import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };

// Builds a database file shaped like the schema before idempotency tracking
// existed: a ticket with a stored message, but no inbound_events table at all.
function legacyDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'desk-legacy-'));
  const path = join(dir, 'desk.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE tickets (
      id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, contact TEXT NOT NULL,
      subject TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'automation',
      draft TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
      approved_version INTEGER, send_state TEXT NOT NULL DEFAULT 'DRAFT'
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, action TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO tickets(id, tenant_id, contact, subject)
      VALUES (101, 'alpha', 'Jordan Demo', 'Cannot resume my practice exam');
    INSERT INTO messages(ticket_id, event_id, body)
      VALUES (101, 'legacy-event-1', 'Already delivered before the upgrade');
  `);
  db.close();
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

test('opening a pre-existing database backfills idempotency so a legacy event does not replay', () => {
  const legacy = legacyDatabase();
  const service = new DeskService({ databasePath: legacy.path, provider: {} });
  try {
    service.receiveWebhook({
      tenantId: 'alpha', ticketId: 101, eventId: 'legacy-event-1', body: 'Replayed after the upgrade'
    });
    const ticket = service.getTicket(alpha, 101);
    assert.deepEqual(ticket.messages.map((message) => message.body), ['Already delivered before the upgrade']);
  } finally {
    service.close();
    legacy.remove();
  }
});
