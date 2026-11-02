// Append-only trail explaining significant actions and unresolved failures
// for a ticket. Entries are never updated or deleted.
export class AuditRepository {
  constructor(db) {
    this.db = db;
  }

  record(ticketId, action, detail) {
    this.db.prepare('INSERT INTO audit(ticket_id, action, detail) VALUES (?, ?, ?)')
      .run(ticketId, action, detail);
  }

  listForTicket(ticketId) {
    return this.db.prepare('SELECT * FROM audit WHERE ticket_id = ? ORDER BY id').all(ticketId);
  }
}
