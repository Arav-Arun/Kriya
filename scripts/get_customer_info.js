import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(url, key);

async function run() {
  // Get the most recent message to identify the customer ID and conversation ID
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .order('id', { ascending: false })
    .limit(1);

  if (!messages || messages.length === 0) {
    console.log("No messages found");
    return;
  }

  const customerId = messages[0].customer_id;
  const conversationId = messages[0].conversation_id;
  console.log("Active Customer ID:", customerId);
  console.log("Active Conversation ID:", conversationId);

  // Get customer profile
  const { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single();

  console.log("Customer details:", customer);

  // Get latest actions log
  const { data: actions } = await supabase
    .from('actions_log')
    .select('*')
    .eq('customer_id', customerId)
    .order('performed_at', { ascending: false })
    .limit(5);

  console.log("Recent actions:", actions);
}

run();
