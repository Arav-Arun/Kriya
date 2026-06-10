import { sqlite } from '@flue/runtime/node';

// Flue runtime state: agent sessions, submissions, workflow runs and events.
// Business data (customers, transactions, cases, tickets) lives in
// data/.sentinel.db — see src/lib/sentinel-db.ts.
// The dot-prefixed filename keeps the SQLite files (and their -shm/-wal
// sidecars) out of `flue dev`'s file watcher, which would otherwise rebuild
// in a loop on every database write.
export default sqlite('./data/.flue.db');
