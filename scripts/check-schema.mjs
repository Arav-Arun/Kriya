// Reports which Kriya tables exist in the configured Supabase project.
// Usage: node --env-file=.env scripts/check-schema.mjs
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const candidates = ['customers','transactions','payments','fees','emis','disputes','subscriptions','escalations','actions_log','conversations','messages','attachments','statements','cases','refunds','provider_events','voice_sessions','audit_packets','channel_messages','mandates'];
for (const t of candidates) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
  console.log(t.padEnd(20), error ? `MISSING (${error.code})` : `exists, ${count} rows`);
}
