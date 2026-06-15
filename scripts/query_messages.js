import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing Supabase credentials in env");
  process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .order('id', { ascending: false })
    .limit(15);
  
  if (error) {
    console.error(error);
    process.exit(1);
  }

  for (const r of data.reverse()) {
    console.log(`[${r.role.toUpperCase()}] ${r.content}`);
    console.log(`Meta: ${JSON.stringify(r.meta)}`);
    console.log('-'.repeat(40));
  }
}

run();
