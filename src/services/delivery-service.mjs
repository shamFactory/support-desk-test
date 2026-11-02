import { randomUUID } from 'node:crypto';
import { isUniqueConflict, withImmediateTransaction } from '../db/connection.mjs';
import { DeskError } from '../errors.mjs';
import { classifyLookup, classifySendError, describeRequester } from '../policies/delivery-policy.mjs';
import { syncSendState } from './send-state-sync.mjs';

// Sending and reconciling provider delivery. The central rule enforced here:
// an attempt row is committed, naming who requested it, before the provider
// is ever called. A crash or a second click then finds that row and must
// not create another delivery for the same approved version.
export class DeliveryService {
  constructor({ db, tickets, attempts, audit, provider }) {
    this.db = db;
    this.tickets = tickets;
    this.attempts = attempts;
    this.audit = audit;
    this.provider = provider;
  }

  async send(actor, id, { automatic = false } = {}) {
    const claim = this.claim(actor, id, automatic);
    try {
      const result = await this.provider.send({ clientRef: claim.clientRef, ticketId: id, body: claim.body });
      this.finish(claim.clientRef, result?.providerMessageId
        ? { kind: 'sent', providerMessageId: result.providerMessageId }
        : { kind: 'unknown' });
    } catch (error) {
      if (error instanceof DeskError) throw error;
      this.finish(claim.clientRef, classifySendError(error));
    }
  }

  // Validates approval, takeover, and one-attempt-per-version, then inserts
  // the UNKNOWN attempt row that makes the send durable before any network call.
  claim(actor, id, automatic) {
    try {
      return withImmediateTransaction(this.db, () => {
        const ticket = this.tickets.requireForActor(actor, id);
        if (automatic && ticket.owner === 'human') throw new DeskError(409, 'Automation stopped after takeover');
        if (this.attempts.findUnknown(ticket.id)) {
          throw new DeskError(409, 'Delivery is uncertain. Check delivery before sending again.');
        }
        if (!ticket.draft || ticket.approved_version !== ticket.version) {
          throw new DeskError(409, 'Approve the exact saved draft first');
        }
        if (this.attempts.findForVersion(ticket.id, ticket.version)) {
          throw new DeskError(409, 'This approved version was already attempted.');
        }
        const clientRef = randomUUID();
        this.attempts.insertClaim({
          ticketId: ticket.id, version: ticket.version, clientRef, body: ticket.draft,
          requestedBy: actor.id, automatic
        });
        this.audit.record(ticket.id, 'delivery_claimed', clientRef);
        syncSendState(this.tickets, this.attempts, ticket.id);
        return { ticketId: ticket.id, clientRef, body: ticket.draft };
      });
    } catch (error) {
      // Two overlapping sends can both pass the findForVersion check before either
      // commits; the loser hits this UNIQUE conflict instead of double-claiming.
      if (isUniqueConflict(error)) throw new DeskError(409, 'This approved version was already attempted.');
      throw error;
    }
  }

  // Applies the provider's response to the claimed attempt. Guarded by
  // re-reading the attempt's state inside the transaction: if reconcile
  // already resolved it first, this becomes a no-op instead of overwriting it.
  finish(clientRef, outcome) {
    withImmediateTransaction(this.db, () => {
      const attempt = this.attempts.findByClientRef(clientRef);
      if (!attempt || attempt.state !== 'UNKNOWN') return;
      const who = describeRequester(attempt);
      if (outcome.kind === 'sent') {
        this.attempts.markSent(clientRef, outcome.providerMessageId);
        this.audit.record(attempt.ticket_id, 'sent', `${who}: ${outcome.providerMessageId}`);
      } else if (outcome.kind === 'rejected') {
        this.attempts.markRejected(clientRef);
        this.audit.record(attempt.ticket_id, 'delivery_rejected', `${who}: ${clientRef}`);
      } else {
        this.audit.record(attempt.ticket_id, 'delivery_unconfirmed', `${who}: ${clientRef}`);
      }
      syncSendState(this.tickets, this.attempts, attempt.ticket_id);
    });
  }

  // Resolves the last uncertain attempt using provider evidence. A provider
  // "not_found" is inconclusive and must not authorize a resend.
  async reconcile(actor, id) {
    const ticket = this.tickets.requireForActor(actor, id);
    const attempt = this.attempts.findUnknown(ticket.id);
    if (!attempt) throw new DeskError(409, 'There is no uncertain delivery to check');
    let lookup;
    try {
      lookup = await this.provider.lookup(attempt.client_ref);
    } catch {
      this.audit.record(ticket.id, 'reconcile_unavailable', attempt.client_ref);
      return;
    }
    const outcome = classifyLookup(lookup);
    const who = describeRequester(attempt);
    withImmediateTransaction(this.db, () => {
      const current = this.attempts.findByClientRef(attempt.client_ref);
      if (current?.state !== 'UNKNOWN') return;
      if (outcome.kind === 'delivered') {
        this.attempts.markSent(attempt.client_ref, outcome.providerMessageId);
        this.audit.record(ticket.id, 'reconciled', `${who}: ${outcome.providerMessageId}`);
      } else {
        this.audit.record(ticket.id, 'reconcile_inconclusive', attempt.client_ref);
      }
      syncSendState(this.tickets, this.attempts, ticket.id);
    });
  }
}
