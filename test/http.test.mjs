import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeskService } from '../src/service.mjs';
import { ProviderClient } from '../src/provider-client.mjs';
import { createApp } from '../src/server.mjs';

function temporaryDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'desk-'));
  return {
    path: join(dir, 'desk.sqlite'),
    remove() { rmSync(dir, { recursive: true, force: true }); }
  };
}

async function request(base, path, { method = 'GET', token, secret, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (secret) headers['X-Demo-Webhook-Secret'] = secret;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* HTML home page. */ }
  return { status: response.status, body: parsed };
}

async function usingApp(fn) {
  const database = temporaryDatabase();
  const service = new DeskService({
    databasePath: database.path,
    provider: {
      async send() { return { providerMessageId: 'http-1' }; },
      async lookup() { return { state: 'not_found' }; }
    }
  });
  const server = createApp(service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    server.close();
    service.close();
    await once(server, 'close');
    database.remove();
  }
}

test('a webhook without the fixture secret is rejected', async () => {
  await usingApp(async (base) => {
    const response = await request(base, '/webhooks/ghl', {
      method: 'POST',
      body: { tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'Please help' }
    });
    assert.equal(response.status, 401);
    const ticket = await request(base, '/api/tickets/101', { token: 'demo-alpha-token' });
    assert.equal(ticket.body.messages.length, 0);
  });
});

test('replaying the webhook route does not store a second message', async () => {
  await usingApp(async (base) => {
    const event = { tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: '<img src=x onerror=alert(1)>' };
    const first = await request(base, '/webhooks/ghl', { method: 'POST', secret: 'fictional-webhook-secret', body: event });
    const second = await request(base, '/webhooks/ghl', { method: 'POST', secret: 'fictional-webhook-secret', body: event });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const ticket = await request(base, '/api/tickets/101', { token: 'demo-alpha-token' });
    assert.deepEqual(ticket.body.messages.map((message) => message.body), ['<img src=x onerror=alert(1)>']);
  });
});

test('a bearer token cannot cross organizations by passing another tenantId', async () => {
  await usingApp(async (base) => {
    const stolen = await request(base, '/api/tickets/101/draft', {
      method: 'POST',
      token: 'demo-beta-token',
      body: { body: 'Stolen reply', tenantId: 'alpha' }
    });
    assert.equal(stolen.status, 404);
    const hidden = await request(base, '/api/tickets/101', { token: 'demo-beta-token' });
    assert.equal(hidden.status, 404);
    const ticket = await request(base, '/api/tickets/101', { token: 'demo-alpha-token' });
    assert.equal(ticket.body.draft, '');
    const inbox = await request(base, '/api/tickets', { token: 'demo-beta-token' });
    assert.deepEqual(inbox.body.map((row) => row.id), [202]);
  });
});

test('an unexpected service failure does not leak its internal message to the client', async () => {
  const brokenService = {
    listTickets() {
      throw new Error('ENOENT: no such file or directory, open /app/data/secret-internal-path.sqlite');
    }
  };
  const server = createApp(brokenService);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await request(base, '/api/tickets', { token: 'demo-alpha-token' });
    assert.equal(response.status, 502);
    assert.equal(response.body.error, 'Unexpected server error');
    assert.doesNotMatch(response.body.error, /secret-internal-path/);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

test('provider timeout and explicit rejection keep their delivery states', async () => {
  const provider = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/messages') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const status = payload.body === 'Reject this' ? 503 : 504;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 503 ? 'Explicitly not accepted' : 'Delivery result unavailable' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'not_found' }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const database = temporaryDatabase();
  const service = new DeskService({
    databasePath: database.path,
    provider: new ProviderClient(`http://127.0.0.1:${provider.address().port}`)
  });
  try {
    const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
    service.updateDraft(alpha, 101, 'Reject this');
    service.approveDraft(alpha, 101);
    const rejected = await service.sendReply(alpha, 101);
    assert.equal(rejected.send_state, 'FAILED');
    service.updateDraft(alpha, 101, 'Timeout this');
    service.approveDraft(alpha, 101);
    const uncertain = await service.sendReply(alpha, 101);
    assert.equal(uncertain.send_state, 'UNKNOWN');
    assert.equal(uncertain.attempts.length, 2);
  } finally {
    service.close();
    provider.closeAllConnections();
    provider.close();
    await once(provider, 'close');
    database.remove();
  }
});
