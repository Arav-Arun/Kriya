import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(url, key);

async function run() {
  const { data: statements, error } = await supabase
    .from('statements')
    .select('*')
    .eq('customer_id', 1999);
  
  if (error) {
    console.error(error);
    return;
  }
  
  console.log("Statements for customer 1999:", statements);
}

run();
