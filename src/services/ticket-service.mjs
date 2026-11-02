import { withImmediateTransaction } from '../db/connection.mjs';
import { DeskError } from '../errors.mjs';
import { describeNextAction } from '../policies/delivery-policy.mjs';
import { syncSendState } from './send-state-sync.mjs';

// Ticket CRUD that does not involve webhooks or provider delivery: listing,
// reading the assembled view, saving a draft, approving it, and handoff.
export class TicketService {
  constructor({ db, tickets, messages, audit, attempts }) {
    this.db = db;
    this.tickets = tickets;
    this.messages = messages;
    this.audit = audit;
    this.attempts = attempts;
  }

  list(actor) {
    return this.tickets.listByTenant(actor.tenantId);
  }

  // Assembles the single read model the UI and HTTP layer both consume:
  // the ticket row plus its conversation, audit trail, delivery attempts,
  // and the next safe action computed from that state.
  get(actor, id) {
    const row = this.tickets.requireForActor(actor, id);
    const view = {
      ...row,
      messages: this.messages.listForTicket(row.id),
      audit: this.audit.listForTicket(row.id),
      attempts: this.attempts.listForTicket(row.id)
    };
    return { ...view, nextAction: describeNextAction(view) };
  }

  updateDraft(actor, id, body) {
    if (typeof body !== 'string' || !body.trim()) throw new DeskError(400, 'A reply is required');
    withImmediateTransaction(this.db, () => {
      const ticket = this.tickets.requireForActor(actor, id);
      this.tickets.saveDraft(ticket.id, actor.tenantId, body);
      this.audit.record(ticket.id, 'draft_updated', actor.id);
      // Editing invalidates the previous version's delivery outcome for display.
      syncSendState(this.tickets, this.attempts, ticket.id);
    });
  }

  approve(actor, id) {
    withImmediateTransaction(this.db, () => {
      const ticket = this.tickets.requireForActor(actor, id);
      if (!ticket.draft) throw new DeskError(400, 'No draft');
      this.tickets.approve(ticket.id, actor.tenantId);
      this.audit.record(ticket.id, 'approved', actor.id);
    });
  }

  handoff(actor, id) {
    withImmediateTransaction(this.db, () => {
      const ticket = this.tickets.requireForActor(actor, id);
      this.tickets.setOwnerHuman(ticket.id, actor.tenantId);
      this.audit.record(ticket.id, 'human_handoff', actor.id);
    });
  }
}
