import { DeskService } from '../src/service.mjs';

const service = new DeskService({ databasePath: process.env.DESK_DB, provider: {} });
try {
  service.receiveWebhook(JSON.parse(process.env.DESK_EVENT));
} finally {
  service.close();
}
