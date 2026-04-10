// lib/clientMatcher.js
// Matches extracted business name to a GHL client in Supabase

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export async function findClient(businessName) {
  if (!businessName) return null;

  const normalized = businessName.toLowerCase().trim();

  // Fetch all active clients
  const { data: clients, error } = await supabase
    .from('booking_agent_clients')
    .select('*')
    .eq('is_active', true);

  if (error || !clients) {
    console.error('Supabase error fetching clients:', error);
    return null;
  }

  // Try exact match first
  for (const client of clients) {
    if (client.business_name.toLowerCase() === normalized) {
      return client;
    }
  }

  // Try alias match
  for (const client of clients) {
    const aliases = client.business_name_aliases || [];
    for (const alias of aliases) {
      if (alias.toLowerCase() === normalized) {
        return client;
      }
    }
  }

  // Try fuzzy partial match (contains)
  for (const client of clients) {
    const clientName = client.business_name.toLowerCase();
    if (clientName.includes(normalized) || normalized.includes(clientName)) {
      return client;
    }
    // Check aliases for partial match
    const aliases = client.business_name_aliases || [];
    for (const alias of aliases) {
      const aliasLower = alias.toLowerCase();
      if (aliasLower.includes(normalized) || normalized.includes(aliasLower)) {
        return client;
      }
    }
  }

  console.warn(`No client match found for business name: "${businessName}"`);
  return null;
}

export async function logBooking(logData) {
  const { error } = await supabase
    .from('booking_agent_logs')
    .insert([logData]);

  if (error) {
    console.error('Supabase log error:', error);
  }
}

export async function updateLog(id, updates) {
  const { error } = await supabase
    .from('booking_agent_logs')
    .update(updates)
    .eq('id', id);

  if (error) {
    console.error('Supabase update log error:', error);
  }
}

// Check if we've already processed this AgentMail message (idempotency)
export async function isAlreadyProcessed(messageId) {
  const { data, error } = await supabase
    .from('booking_agent_logs')
    .select('id')
    .eq('agentmail_message_id', messageId)
    .not('processing_status', 'eq', 'failed')
    .limit(1);

  if (error) return false;
  return data && data.length > 0;
}
