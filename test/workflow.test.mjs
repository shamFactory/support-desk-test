import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const beta = { id: 'agent-beta', tenantId: 'beta' };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inbound = {
  tenantId: 'alpha',
  ticketId: 101,
  eventId: 'event-1',
  body: 'Please help'
};

function temporaryDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'desk-'));
  return {
    path: join(dir, 'desk.sqlite'),
    remove() { rmSync(dir, { recursive: true, force: true }); }
  };
}

function provider(mode = 'ok') {
  const sent = [];
  const lookedUp = [];
  return {
    sent,
    lookedUp,
    async send(payload) {
      sent.push(payload);
      if (mode === 'timeout') {
        const error = new Error('timeout');
        error.kind = 'unknown';
        throw error;
      }
      if (mode === 'reject') {
        const error = new Error('rejected');
        error.kind = 'not_accepted';
        throw error;
      }
      return { providerMessageId: 'provider-1' };
    },
    async lookup(clientRef) {
      lookedUp.push(clientRef);
      if (mode === 'delivered') return { state: 'delivered', providerMessageId: 'provider-9', count: 1 };
      if (mode === 'lookup-down') throw new Error('Lookup unavailable');
      return { state: 'not_found' };
    }
  };
}

async function using(mode, fn) {
  const database = temporaryDatabase();
  const gateway = provider(mode);
  const service = new DeskService({ databasePath: database.path, provider: gateway });
  try {
    return await fn(service, gateway);
  } finally {
    service.close();
    database.remove();
  }
}

function approve(service, actor, id, body) {
  service.updateDraft(actor, id, body);
  service.approveDraft(actor, id);
}

test('replaying one organization event stores a single customer message', async () => {
  await using('ok', service => {
    service.receiveWebhook(inbound);
    service.receiveWebhook({ ...inbound, body: 'A second copy must not land' });
    const ticket = service.getTicket(alpha, 101);
    assert.deepEqual(ticket.messages.map(message => message.body), ['Please help']);
    assert.equal(ticket.audit.filter(entry => entry.action === 'inbound').length, 1);
  });
});

test('alpha and beta may both store an event with the same id', async () => {
  await using('ok', service => {
    service.receiveWebhook(inbound);
    service.receiveWebhook({ tenantId: 'beta', ticketId: 202, eventId: 'event-1', body: 'Beta needs help' });
    assert.equal(service.getTicket(alpha, 101).messages.length, 1);
    assert.deepEqual(service.getTicket(beta, 202).messages.map(message => message.body), ['Beta needs help']);
  });
});

test('a webhook for a ticket outside its organization is rejected', async () => {
  await using('ok', service => {
    assert.throws(
      () => service.receiveWebhook({ tenantId: 'beta', ticketId: 101, eventId: 'event-9', body: 'Wrong org' }),
      (error) => error.status === 400
    );
    assert.equal(service.getTicket(alpha, 101).messages.length, 0);
  });
});

test('overlapping webhook deliveries still store one message', async () => {
  const database = temporaryDatabase();
  const setup = new DeskService({ databasePath: database.path, provider: {} });
  setup.close();
  const event = JSON.stringify(inbound);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['test/replay-once.mjs'], {
      cwd: root,
      env: { ...process.env, DESK_DB: database.path, DESK_EVENT: event }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `replay exited ${code}`))));
  });
  try {
    await Promise.all([run(), run()]);
    const service = new DeskService({ databasePath: database.path, provider: {} });
    try {
      assert.equal(service.getTicket(alpha, 101).messages.length, 1);
    } finally {
      service.close();
    }
  } finally {
    database.remove();
  }
});

test('another organization cannot read or change a ticket by guessing its id', async () => {
  await using('ok', async (service) => {
    approve(service, alpha, 101, 'Alpha only');
    for (const action of [
      () => service.getTicket(beta, 101),
      () => service.updateDraft(beta, 101, 'Stolen reply'),
      () => service.approveDraft(beta, 101),
      () => service.handoff(beta, 101)
    ]) {
      assert.throws(action, (error) => error.status === 404);
    }
    await assert.rejects(() => service.reconcile(beta, 101), (error) => error.status === 404);
    await assert.rejects(() => service.sendReply(beta, 101), (error) => error.status === 404);
    const ticket = service.getTicket(alpha, 101);
    assert.equal(ticket.draft, 'Alpha only');
    assert.equal(ticket.owner, 'automation');
    assert.equal(ticket.messages.length, 0);
  });
});

test('sending requires approval of the exact saved draft', async () => {
  await using('ok', async (service, gateway) => {
    service.updateDraft(alpha, 101, 'Not approved yet');
    await assert.rejects(() => service.sendReply(alpha, 101), (error) => error.status === 409);
    service.approveDraft(alpha, 101);
    service.updateDraft(alpha, 101, 'Edited after approval');
    await assert.rejects(() => service.sendReply(alpha, 101), (error) => error.status === 409);
    assert.equal(gateway.sent.length, 0);
    assert.equal(service.getTicket(alpha, 101).approved_version, null);
  });
});

test('one approved version is sent once, including overlapping clicks', async () => {
  const database = temporaryDatabase();
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const gateway = {
    calls: 0,
    async send() {
      this.calls += 1;
      if (this.calls === 1) await hold;
      return { providerMessageId: 'once' };
    },
    async lookup() { return { state: 'not_found' }; }
  };
  const first = new DeskService({ databasePath: database.path, provider: gateway });
  const second = new DeskService({ databasePath: database.path, provider: gateway });
  try {
    approve(first, alpha, 101, 'Send this once');
    const pending = Promise.allSettled([
      first.sendReply(alpha, 101),
      second.sendReply(alpha, 101)
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const results = await pending;
    assert.equal(gateway.calls, 1);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(first.getTicket(alpha, 101).send_state, 'SENT');
  } finally {
    first.close();
    second.close();
    database.remove();
  }
});

test('a timeout stays UNKNOWN and a restart does not send it again', async () => {
  const database = temporaryDatabase();
  const firstGateway = provider('timeout');
  const first = new DeskService({ databasePath: database.path, provider: firstGateway });
  let clientRef;
  try {
    approve(first, alpha, 101, 'Maybe delivered');
    const ticket = await first.sendReply(alpha, 101);
    assert.equal(ticket.send_state, 'UNKNOWN');
    assert.equal(firstGateway.sent.length, 1);
    clientRef = ticket.attempts[0].client_ref;
    assert.equal(firstGateway.sent[0].clientRef, clientRef);
    await assert.rejects(() => first.sendReply(alpha, 101), (error) => error.status === 409);
    assert.equal(firstGateway.sent.length, 1);
  } finally {
    first.close();
  }
  const secondGateway = provider('ok');
  const second = new DeskService({ databasePath: database.path, provider: secondGateway });
  try {
    await assert.rejects(() => second.sendReply(alpha, 101), (error) => error.status === 409);
    assert.equal(secondGateway.sent.length, 0);
    assert.equal(second.getTicket(alpha, 101).attempts[0].client_ref, clientRef);
    assert.equal(second.getTicket(alpha, 101).send_state, 'UNKNOWN');
  } finally {
    second.close();
    database.remove();
  }
});

test('checking delivery resolves a confirmed attempt without sending again', async () => {
  await using('delivered', async (service, gateway) => {
    approve(service, alpha, 101, 'Confirm me');
    gateway.send = async () => {
      gateway.sent.push({ clientRef: 'ignored' });
      const error = new Error('timeout');
      error.kind = 'unknown';
      throw error;
    };
    await service.sendReply(alpha, 101);
    const ticket = await service.reconcile(alpha, 101);
    assert.equal(ticket.send_state, 'SENT');
    assert.equal(ticket.attempts[0].provider_id, 'provider-9');
    assert.equal(gateway.sent.length, 1);
    assert.deepEqual(gateway.lookedUp, [ticket.attempts[0].client_ref]);
  });
});

test('a provider not_found result stays uncertain and does not send again', async () => {
  await using('not_found', async (service, gateway) => {
    approve(service, alpha, 101, 'Missing at the provider');
    gateway.send = async (payload) => {
      gateway.sent.push(payload);
      const error = new Error('timeout');
      error.kind = 'unknown';
      throw error;
    };
    await service.sendReply(alpha, 101);
    const ticket = await service.reconcile(alpha, 101);
    assert.equal(ticket.send_state, 'UNKNOWN');
    assert.equal(gateway.sent.length, 1);
    await assert.rejects(() => service.sendReply(alpha, 101), (error) => error.status === 409);
    assert.equal(gateway.sent.length, 1);
  });
});

test('an unavailable delivery check does not change an uncertain attempt', async () => {
  await using('lookup-down', async (service, gateway) => {
    approve(service, alpha, 101, 'Lookup will fail');
    gateway.send = async (payload) => {
      gateway.sent.push(payload);
      const error = new Error('timeout');
      error.kind = 'unknown';
      throw error;
    };
    await service.sendReply(alpha, 101);
    const ticket = await service.reconcile(alpha, 101);
    assert.equal(ticket.send_state, 'UNKNOWN');
    assert.equal(gateway.sent.length, 1);
    assert.equal(ticket.audit.some((entry) => entry.action === 'reconcile_unavailable'), true);
  });
});

test('an explicit provider rejection is a failed attempt and is not retried', async () => {
  await using('reject', async (service, gateway) => {
    approve(service, alpha, 101, 'Rejected before accept');
    const ticket = await service.sendReply(alpha, 101);
    assert.equal(ticket.send_state, 'FAILED');
    assert.notEqual(ticket.send_state, 'SENT');
    assert.equal(gateway.sent.length, 1);
    await assert.rejects(() => service.sendReply(alpha, 101), (error) => error.status === 409);
    assert.equal(gateway.sent.length, 1);
    approve(service, alpha, 101, 'A new approved version');
    const retried = await service.sendReply(alpha, 101);
    assert.equal(retried.send_state, 'FAILED');
    assert.equal(gateway.sent.length, 2);
  });
});

test('takeover stops a later automation dispatch and still allows a human send', async () => {
  await using('ok', async (service, gateway) => {
    approve(service, alpha, 101, 'Human will send this');
    service.handoff(alpha, 101);
    await assert.rejects(
      () => service.sendReply(alpha, 101, { automatic: true }),
      (error) => error.status === 409
    );
    assert.equal(gateway.sent.length, 0);
    const ticket = await service.sendReply(alpha, 101);
    assert.equal(ticket.owner, 'human');
    assert.equal(ticket.send_state, 'SENT');
    assert.equal(gateway.sent.length, 1);
  });
});

test('the audit trail names the human agent who triggered a successful send', async () => {
  await using('ok', async (service) => {
    approve(service, alpha, 101, 'Human sends this');
    const ticket = await service.sendReply(alpha, 101);
    const sent = ticket.audit.find((entry) => entry.action === 'sent');
    assert.match(sent.detail, /^agent-alpha:/);
  });
});

test('the audit trail marks a successful automation dispatch as automation', async () => {
  await using('ok', async (service) => {
    approve(service, alpha, 101, 'Automation sends this');
    const ticket = await service.sendReply(alpha, 101, { automatic: true });
    const sent = ticket.audit.find((entry) => entry.action === 'sent');
    assert.match(sent.detail, /^automation:/);
  });
});

test('reconciling a delivery still credits whoever originally sent it', async () => {
  await using('delivered', async (service, gateway) => {
    approve(service, alpha, 101, 'Confirm me');
    gateway.send = async () => {
      const error = new Error('timeout');
      error.kind = 'unknown';
      throw error;
    };
    await service.sendReply(alpha, 101);
    const ticket = await service.reconcile(alpha, 101);
    const reconciled = ticket.audit.find((entry) => entry.action === 'reconciled');
    assert.match(reconciled.detail, /^agent-alpha:/);
  });
});

test('the ticket tells the agent the next safe action', async () => {
  await using('timeout', async (service) => {
    const saved = service.updateDraft(alpha, 101, 'Needs approval');
    assert.match(saved.nextAction, /approve/i);
    service.approveDraft(alpha, 101);
    const uncertain = await service.sendReply(alpha, 101);
    assert.equal(uncertain.send_state, 'UNKNOWN');
    assert.match(uncertain.nextAction, /check delivery/i);
    assert.match(uncertain.nextAction, /do not send/i);
  });
});
