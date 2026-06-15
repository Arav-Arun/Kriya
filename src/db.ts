import { sqlite } from '@flue/runtime/node';
import { postgres } from '@flue/postgres';
import { config } from './config/env.ts';

// Flue runtime state: agent sessions, submissions, workflow runs and events.
// Hosted Postgres (DATABASE_URL) in deployed environments; SQLite is a
// development-only fallback and refuses to engage when deployed unless
// ALLOW_LOCAL_FLUE_SQLITE=true is set explicitly.
if (!config.databaseUrl && config.deployed && !config.allowLocalFlueSqlite) {
  throw new Error(
    'Kriya refuses to start: deployed mode requires DATABASE_URL for Flue run state. '
    + 'Set ALLOW_LOCAL_FLUE_SQLITE=true only for non-production deployments.',
  );
}

export default config.databaseUrl
  ? postgres(config.databaseUrl)
  : sqlite('./data/.flue.db');
