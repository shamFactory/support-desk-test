// Schema definition and forward migrations for the desk database. Every
// function here is safe to call on every startup: CREATE TABLE IF NOT EXISTS,
// ALTER TABLE only when a column is missing, and INSERT OR IGNORE for seeds
// and backfills. That lets a single openStore() handle both a brand-new
// database and one produced by an older version of this application.

// The two fixture tenants and their starting tickets, published in CONTRACT.md.
const FIXTURE_TICKETS = [
  { id: 101, tenantId: 'alpha', contact: 'Jordan Demo', subject: 'Cannot resume my practice exam' },
  { id: 202, tenantId: 'beta', contact: 'Casey Example', subject: 'Course completion is missing' }
];

export function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, contact TEXT NOT NULL,
      subject TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'automation',
      draft TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
      approved_version INTEGER, send_state TEXT NOT NULL DEFAULT 'DRAFT'
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, event_id TEXT NOT NULL,
      body TEXT NOT NULL
    );
    -- Event ids repeat across organizations. This key is the idempotency record;
    -- the message row is written in the same transaction or not at all.
    CREATE TABLE IF NOT EXISTS inbound_events (
      tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, ticket_id INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, action TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, version INTEGER NOT NULL,
      client_ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
      state TEXT NOT NULL, provider_id TEXT,
      requested_by TEXT, automatic INTEGER NOT NULL DEFAULT 0,
      UNIQUE(ticket_id, version)
    );
  `);
  const insertTicket = db.prepare(
    'INSERT OR IGNORE INTO tickets(id, tenant_id, contact, subject) VALUES (?, ?, ?, ?)'
  );
  for (const ticket of FIXTURE_TICKETS) {
    insertTicket.run(ticket.id, ticket.tenantId, ticket.contact, ticket.subject);
  }
}

// Adds columns introduced after the attempts table already existed in the
// field (requested_by / automatic, added so the audit trail can name who
// triggered a send). A fresh database already has them from createSchema;
// this only does work for a database created by an older version.
export function migrateAttemptColumns(db) {
  const columns = db.prepare('PRAGMA table_info(attempts)').all().map((column) => column.name);
  if (!columns.includes('requested_by')) db.exec('ALTER TABLE attempts ADD COLUMN requested_by TEXT');
  if (!columns.includes('automatic')) db.exec('ALTER TABLE attempts ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0');
}

// Backfills inbound_events from any messages stored before that idempotency
// table existed. Without this, upgrading a running deployment would treat
// every previously stored event as unseen and duplicate it on the next replay.
export function backfillInboundEvents(db) {
  db.exec(`
    INSERT OR IGNORE INTO inbound_events (tenant_id, event_id, ticket_id)
    SELECT tickets.tenant_id, messages.event_id, messages.ticket_id
    FROM messages
    JOIN tickets ON tickets.id = messages.ticket_id;
  `);
}
