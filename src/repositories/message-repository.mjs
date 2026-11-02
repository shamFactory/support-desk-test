// Inbound customer messages, plus the (tenant_id, event_id) idempotency key
// that guards against a webhook replay appending the same message twice.
export class MessageRepository {
  constructor(db) {
    this.db = db;
  }

  hasSeenEvent(tenantId, eventId) {
    return Boolean(
      this.db.prepare('SELECT 1 FROM inbound_events WHERE tenant_id = ? AND event_id = ?').get(tenantId, eventId)
    );
  }

  // Inserts the idempotency key and the message body together. Call inside a
  // transaction: either both rows land, or (on a UNIQUE conflict from a
  // concurrent duplicate) neither does.
  recordInbound(tenantId, eventId, ticketId, body) {
    this.db.prepare('INSERT INTO inbound_events(tenant_id, event_id, ticket_id) VALUES (?, ?, ?)')
      .run(tenantId, eventId, ticketId);
    this.db.prepare('INSERT INTO messages(ticket_id, event_id, body) VALUES (?, ?, ?)')
      .run(ticketId, eventId, body);
  }

  listForTicket(ticketId) {
    return this.db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id').all(ticketId);
  }
}
