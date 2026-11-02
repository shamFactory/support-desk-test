import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { backfillInboundEvents, createSchema, migrateAttemptColumns } from './schema.mjs';

// Opens (creating if needed) the SQLite file used by the desk application,
// bringing it up to the current schema regardless of which earlier version
// of this app last wrote to it.
export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  // timeout applies before the first statement, so a second process waits
  // instead of failing while this connection creates the schema.
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
  `);
  createSchema(db);
  migrateAttemptColumns(db);
  backfillInboundEvents(db);
  return db;
}

// IMMEDIATE takes the write lock before the callback reads anything.
// Overlapping requests then wait on this lock instead of both deciding that
// an event, draft edit, or send attempt is new.
export function withImmediateTransaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* The transaction is already closed. */ }
    throw error;
  }
}

// True when a write lost a race against a UNIQUE constraint (idempotency key
// or one-attempt-per-version key). Callers treat that race as a success,
// not a failure, since another concurrent request already did the work.
export function isUniqueConflict(error) {
  return typeof error?.message === 'string' && error.message.includes('UNIQUE constraint failed');
}
