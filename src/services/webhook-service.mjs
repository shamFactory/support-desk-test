import { isUniqueConflict, withImmediateTransaction } from '../db/connection.mjs';
import { DeskError } from '../errors.mjs';

// Safe inbound delivery: a webhook replay must not create a second customer
// message or repeat its business effect, including overlapping requests.
// Event identity is scoped to the organization on the event itself.
export class WebhookService {
  constructor({ db, tickets, messages, audit }) {
    this.db = db;
    this.tickets = tickets;
    this.messages = messages;
    this.audit = audit;
  }

  receive(event) {
    if (!event?.eventId || typeof event.body !== 'string' || !event.tenantId || !event.ticketId) {
      throw new DeskError(400, 'Invalid event');
    }
    try {
      return withImmediateTransaction(this.db, () => {
        if (this.messages.hasSeenEvent(event.tenantId, event.eventId)) return { accepted: true };
        const ticket = this.tickets.findForTenant(event.ticketId, event.tenantId);
        if (!ticket) throw new DeskError(400, 'Invalid event');
        // The idempotency key and the message land together: both commit or neither does.
        this.messages.recordInbound(event.tenantId, event.eventId, ticket.id, event.body);
        this.audit.record(ticket.id, 'inbound', event.eventId);
        return { accepted: true };
      });
    } catch (error) {
      // Two overlapping replays can both pass the hasSeenEvent check before either
      // commits; the loser hits this UNIQUE conflict and is still a safe no-op.
      if (isUniqueConflict(error)) return { accepted: true };
      throw error;
    }
  }
}
