// Derives a ticket's displayed send_state from its current version and the
// delivery attempts recorded against it. Shared by TicketService (a draft
// edit can retire an old UNKNOWN/SENT/FAILED state back to DRAFT) and
// DeliveryService (claiming, finishing, or reconciling a send changes it).
export function syncSendState(tickets, attempts, ticketId) {
  const version = tickets.getVersion(ticketId);
  const hasUnknown = Boolean(attempts.findUnknown(ticketId));
  const current = attempts.findForVersion(ticketId, version);
  let sendState = 'DRAFT';
  if (hasUnknown) sendState = 'UNKNOWN';
  else if (current?.state === 'SENT') sendState = 'SENT';
  else if (current?.state === 'REJECTED') sendState = 'FAILED';
  tickets.setSendState(ticketId, sendState);
}
