// Synthetic identities only, published in CONTRACT.md. Treat the server-side
// lookup below as the single source of truth for organization access — a
// tenantId supplied in a request body or query string is never trusted.
export const actors = {
  'demo-alpha-token': { id: 'agent-alpha', tenantId: 'alpha' },
  'demo-beta-token': { id: 'agent-beta', tenantId: 'beta' }
};
