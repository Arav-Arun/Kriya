import { sqlite } from '@flue/runtime/node';
import { postgres } from '@flue/postgres';
import { config } from './core/env.ts';

// Flue persistence layer: Postgres in production, SQLite in development.
if (!config.databaseUrl && config.deployed && !config.allowLocalFlueSqlite) {
  throw new Error(
    'Kriya refuses to start: deployed mode requires DATABASE_URL for Flue run state. '
    + 'Set ALLOW_LOCAL_FLUE_SQLITE=true only for non-production deployments.',
  );
}

export default config.databaseUrl
  ? postgres(config.databaseUrl)
  : sqlite('./data/.flue.db');
