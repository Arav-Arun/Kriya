import { sqlite } from '@flue/runtime/node';
import { postgres } from '@flue/postgres';

// Flue runtime state: agent sessions, submissions, workflow runs and events.
// Uses Supabase Postgres for durability across deploys and restarts.
// Fallback to SQLite locally if DATABASE_URL is not set.
export default process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL)
  : sqlite('./data/.flue.db');
