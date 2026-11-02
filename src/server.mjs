import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { actors } from './actors.mjs';
import { DeskError } from './errors.mjs';
import { DeskService } from './service.mjs';
import { ProviderClient } from './provider-client.mjs';

const page = fileURLToPath(new URL('../public/index.html', import.meta.url));

// HTTP adapter. Organization access comes from the bearer token resolved here.
// A tenantId in the JSON body is never forwarded.
export function createApp(service) {
  const read = async (req) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100000) throw new DeskError(413, 'Body too large');
    }
    try { return body ? JSON.parse(body) : {}; } catch { throw new DeskError(400, 'Invalid JSON'); }
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(page));
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/ghl') {
        if (req.headers['x-demo-webhook-secret'] !== 'fictional-webhook-secret') {
          throw new DeskError(401, 'Invalid webhook secret');
        }
        return json(res, 200, service.receiveWebhook(await read(req)));
      }
      const actor = actors[(req.headers.authorization || '').replace(/^Bearer /, '')];
      if (!actor) throw new DeskError(401, 'Sign in using a demo identity');
      if (req.method === 'GET' && url.pathname === '/api/tickets') return json(res, 200, service.listTickets(actor));
      const match = url.pathname.match(/^\/api\/tickets\/(\d+)(?:\/(draft|approve|send|automation|handoff|reconcile))?$/);
      if (!match) throw new DeskError(404, 'Not found');
      const id = Number(match[1]);
      const action = match[2];
      if (req.method === 'GET' && !action) return json(res, 200, service.getTicket(actor, id));
      if (req.method !== 'POST') throw new DeskError(405, 'Method not allowed');
      const body = await read(req);
      let result;
      switch (action) {
        case 'draft': result = service.updateDraft(actor, id, body.body); break;
        case 'approve': result = service.approveDraft(actor, id); break;
        case 'handoff': result = service.handoff(actor, id); break;
        case 'send': result = await service.sendReply(actor, id); break;
        case 'automation': result = await service.sendReply(actor, id, { automatic: true }); break;
        case 'reconcile': result = await service.reconcile(actor, id); break;
        default: throw new DeskError(404, 'Not found');
      }
      json(res, 200, result);
    } catch (error) {
      // A DeskError was raised deliberately with a message meant for the
      // caller. Anything else is unexpected (a bug, a filesystem or SQLite
      // failure) and must not leak internal details such as file paths.
      if (error instanceof DeskError) return json(res, error.status, { error: error.message });
      console.error('Unhandled request error:', error);
      json(res, 502, { error: 'Unexpected server error' });
    }
  });
}

function startedAsMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (startedAsMainModule()) {
  const service = new DeskService({
    databasePath: process.env.DESK_DB || resolve('data/desk.sqlite'),
    provider: new ProviderClient(process.env.PROVIDER_URL)
  });
  const server = createApp(service);
  const port = Number(process.env.PORT || 4300);
  const host = process.env.LISTEN_HOST || '127.0.0.1';
  server.listen(port, host, () => console.log('Support desk: http://127.0.0.1:' + port));
  process.on('SIGTERM', () => server.close(() => { service.close(); process.exit(); }));
}
