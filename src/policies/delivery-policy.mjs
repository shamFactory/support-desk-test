// Delivery decisions live here so persistence and HTTP do not grow their own
// copies. These are pure functions with no database or network access.

export function describeNextAction(ticket) {
  const attempts = ticket.attempts || [];
  if (attempts.some((attempt) => attempt.state === 'UNKNOWN')) {
    return 'Delivery is uncertain. Check delivery before doing anything else. Do not send this reply again.';
  }
  const current = attempts.find((attempt) => attempt.version === ticket.version);
  if (current?.state === 'REJECTED') {
    return 'The provider rejected this reply before accepting it. Edit the draft and approve the new text to try again.';
  }
  if (current?.state === 'SENT') {
    return 'This approved reply was delivered. Save a new draft if the customer needs another reply.';
  }
  if (!ticket.draft || ticket.approved_version !== ticket.version) {
    return 'Save the reply, then approve that exact text. A suggestion is not an approval.';
  }
  if (ticket.owner === 'human') {
    return 'This draft is approved. Send it manually. Automation will not send after takeover.';
  }
  return 'This draft is approved. Send it, or take over the conversation to stop later automation.';
}

// 503 means the provider refused before accepting. Every other failure is uncertain:
// a timeout can still have stored the delivery.
export function classifySendError(error) {
  if (error?.kind === 'not_accepted') return { kind: 'rejected' };
  return { kind: 'unknown' };
}

// not_found is not proof that the send failed, so it must not become a retry.
export function classifyLookup(lookup) {
  if (lookup?.state === 'delivered' && lookup.providerMessageId) {
    return { kind: 'delivered', providerMessageId: lookup.providerMessageId };
  }
  return { kind: 'inconclusive' };
}

// Human-readable attribution used in audit details, e.g. "agent-alpha: ref-123"
// or "automation: ref-123". Attempts always carry who/how they were claimed,
// so this stays correct even when a different actor later reconciles delivery.
export function describeRequester(attempt) {
  return attempt.automatic ? 'automation' : attempt.requested_by;
}
