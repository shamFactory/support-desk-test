// Delivery attempts: one row per approved version that was ever claimed for
// sending. The UNIQUE(ticket_id, version) constraint is what makes
// "one approved version is sent once" true even under overlapping requests.
export class AttemptRepository {
  constructor(db) {
    this.db = db;
  }

  // There can be at most one UNKNOWN attempt per ticket at a time: claiming a
  // new send is blocked while one is outstanding (see DeliveryService.claim).
  // Reused wherever code needs to know "is this ticket's delivery uncertain?"
  // as well as by reconcile, which needs the full row to re-check the provider.
  findUnknown(ticketId) {
    return this.db.prepare(
      `SELECT * FROM attempts WHERE ticket_id = ? AND state = 'UNKNOWN' ORDER BY id DESC LIMIT 1`
    ).get(ticketId);
  }

  findForVersion(ticketId, version) {
    return this.db.prepare('SELECT * FROM attempts WHERE ticket_id = ? AND version = ?').get(ticketId, version);
  }

  findByClientRef(clientRef) {
    return this.db.prepare('SELECT * FROM attempts WHERE client_ref = ?').get(clientRef);
  }

  // requestedBy/automatic are captured at claim time so later steps (the
  // provider's async response, or a human checking delivery afterward) can
  // attribute the outcome to whoever actually triggered the send — not to
  // whichever actor happens to be resolving the response.
  insertClaim({ ticketId, version, clientRef, body, requestedBy, automatic }) {
    this.db.prepare(`
      INSERT INTO attempts(ticket_id, version, client_ref, body, state, requested_by, automatic)
      VALUES (?, ?, ?, ?, 'UNKNOWN', ?, ?)
    `).run(ticketId, version, clientRef, body, requestedBy, automatic ? 1 : 0);
  }

  markSent(clientRef, providerId) {
    this.db.prepare(`UPDATE attempts SET state = 'SENT', provider_id = ? WHERE client_ref = ?`)
      .run(providerId, clientRef);
  }

  markRejected(clientRef) {
    this.db.prepare(`UPDATE attempts SET state = 'REJECTED' WHERE client_ref = ?`).run(clientRef);
  }

  listForTicket(ticketId) {
    return this.db.prepare('SELECT * FROM attempts WHERE ticket_id = ? ORDER BY id').all(ticketId);
  }
}
