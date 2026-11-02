import { openStore } from './db/connection.mjs';
import { AttemptRepository } from './repositories/attempt-repository.mjs';
import { AuditRepository } from './repositories/audit-repository.mjs';
import { MessageRepository } from './repositories/message-repository.mjs';
import { TicketRepository } from './repositories/ticket-repository.mjs';
import { DeliveryService } from './services/delivery-service.mjs';
import { TicketService } from './services/ticket-service.mjs';
import { WebhookService } from './services/webhook-service.mjs';

// Facade over the desk's three workflows (tickets, webhooks, delivery).
// HTTP (server.mjs) and tests depend only on this class, not on the
// repositories or services it wires together — that composition can change
// without touching either caller.
export class DeskService {
  constructor({ databasePath = ':memory:', provider }) {
    this.db = openStore(databasePath);

    const tickets = new TicketRepository(this.db);
    const messages = new MessageRepository(this.db);
    const audit = new AuditRepository(this.db);
    const attempts = new AttemptRepository(this.db);

    this.ticketService = new TicketService({ db: this.db, tickets, messages, audit, attempts });
    this.webhookService = new WebhookService({ db: this.db, tickets, messages, audit });
    this.deliveryService = new DeliveryService({ db: this.db, tickets, attempts, audit, provider });
  }

  close() {
    this.db.close();
  }

  listTickets(actor) {
    return this.ticketService.list(actor);
  }

  getTicket(actor, id) {
    return this.ticketService.get(actor, id);
  }

  receiveWebhook(event) {
    return this.webhookService.receive(event);
  }

  updateDraft(actor, id, body) {
    this.ticketService.updateDraft(actor, id, body);
    return this.getTicket(actor, id);
  }

  approveDraft(actor, id) {
    this.ticketService.approve(actor, id);
    return this.getTicket(actor, id);
  }

  handoff(actor, id) {
    this.ticketService.handoff(actor, id);
    return this.getTicket(actor, id);
  }

  async sendReply(actor, id, options) {
    await this.deliveryService.send(actor, id, options);
    return this.getTicket(actor, id);
  }

  async reconcile(actor, id) {
    await this.deliveryService.reconcile(actor, id);
    return this.getTicket(actor, id);
  }
}
