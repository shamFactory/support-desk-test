import { DeskError } from '../errors.mjs';

// All reads and writes to the tickets table. Every mutation repeats
// `AND tenant_id = ?` even though the row was just loaded for that tenant:
// it is the one place that can never silently drift into updating another
// organization's row if a future caller forgets to check first.
export class TicketRepository {
  constructor(db) {
    this.db = db;
  }

  listByTenant(tenantId) {
    return this.db.prepare('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY id').all(tenantId);
  }

  // Looks up a ticket without tenant scoping, used only to validate an
  // inbound webhook's own declared tenantId/ticketId pair. Returns undefined
  // instead of throwing, since an invalid webhook is a 400, not a 404.
  findForTenant(id, tenantId) {
    return this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  }

  // The signed-in actor's organization is the only tenant key. A matching id
  // in another organization is hidden as "not found" so callers cannot probe it.
  requireForActor(actor, id) {
    const row = this.findForTenant(id, actor.tenantId);
    if (!row) throw new DeskError(404, 'Ticket not found');
    return row;
  }

  // Any save is a new version. The previous approval belonged to the old text.
  saveDraft(ticketId, tenantId, body) {
    this.db.prepare(`
      UPDATE tickets SET draft = ?, version = version + 1, approved_version = NULL
      WHERE id = ? AND tenant_id = ?
    `).run(body, ticketId, tenantId);
  }

  approve(ticketId, tenantId) {
    this.db.prepare('UPDATE tickets SET approved_version = version WHERE id = ? AND tenant_id = ?')
      .run(ticketId, tenantId);
  }

  setOwnerHuman(ticketId, tenantId) {
    this.db.prepare(`UPDATE tickets SET owner = 'human' WHERE id = ? AND tenant_id = ?`)
      .run(ticketId, tenantId);
  }

  getVersion(ticketId) {
    return this.db.prepare('SELECT version FROM tickets WHERE id = ?').get(ticketId).version;
  }

  setSendState(ticketId, sendState) {
    this.db.prepare('UPDATE tickets SET send_state = ? WHERE id = ?').run(sendState, ticketId);
  }
}
