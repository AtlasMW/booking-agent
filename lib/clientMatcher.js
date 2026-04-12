// lib/clientMatcher.js
// Matches extracted business name to a GHL client in Supabase
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function findClient(businessName, locationText) {
  if (!businessName) return null;
  const normalized = businessName.toLowerCase().trim();
  const locationLower = (locationText || '').toLowerCase();

  console.log('[clientMatcher] Searching Supabase for:', normalized);
  if (locationLower) {
    console.log('[clientMatcher] Location context:', locationLower.substring(0, 100));
  }

  // Fetch all active clients
  const { data: clients, error } = await supabase
    .from('booking_agent_clients')
    .select('*')
    .eq('is_active', true);

  if (error || !clients) {
    console.error('[clientMatcher] Supabase error fetching clients:', error);
    return null;
  }

  console.log(`[clientMatcher] Found ${clients.length} active clients`);

  // Collect all matching clients (there may be multiple for multi-location businesses)
  let matches = [];

  // Try exact match first
  for (const client of clients) {
    if (client.business_name.toLowerCase() === normalized) {
      matches.push(client);
    }
  }

  // Try alias match if no exact matches
  if (matches.length === 0) {
    for (const client of clients) {
      const aliases = client.business_name_aliases || [];
      for (const alias of aliases) {
        if (alias.toLowerCase() === normalized) {
          matches.push(client);
          break;
        }
      }
    }
  }

  // Try fuzzy partial match if still no matches
  if (matches.length === 0) {
    for (const client of clients) {
      const clientName = client.business_name.toLowerCase();
      if (clientName.includes(normalized) || normalized.includes(clientName)) {
        matches.push(client);
        continue;
      }
      // Check aliases for partial match
      const aliases = client.business_name_aliases || [];
      for (const alias of aliases) {
        const aliasLower = alias.toLowerCase();
        if (aliasLower.includes(normalized) || normalized.includes(aliasLower)) {
          matches.push(client);
          break;
        }
      }
    }
  }

  // If only one match, return it
  if (matches.length === 1) {
    console.log(`[clientMatcher] Single match: ${matches[0].business_name} (location_keyword: ${matches[0].location_keyword || 'none'})`);
    return matches[0];
  }

  // If multiple matches, use location_keyword to narrow down
  if (matches.length > 1 && locationLower) {
    console.log(`[clientMatcher] Multiple matches (${matches.length}) — using location to narrow down`);

    const locationMatches = matches.filter(client => {
      const keyword = (client.location_keyword || '').toLowerCase();
      if (!keyword) return false;
      return locationLower.includes(keyword);
    });

    if (locationMatches.length === 1) {
      console.log(`[clientMatcher] Location match: ${locationMatches[0].business_name} (keyword: ${locationMatches[0].location_keyword})`);
      return locationMatches[0];
    }

    if (locationMatches.length > 1) {
      console.warn(`[clientMatcher] Multiple location matches (${locationMatches.length}) — returning first`);
      return locationMatches[0];
    }

    // No location keyword matched — return first match but warn
    console.warn(`[clientMatcher] No location keyword matched in: "${locationLower.substring(0, 100)}"`);
    console.warn(`[clientMatcher] Available keywords: ${matches.map(m => m.location_keyword).join(', ')}`);
    return matches[0];
  }

  // Multiple matches but no location context
  if (matches.length > 1) {
    console.warn(`[clientMatcher] Multiple matches (${matches.length}) with no location context — returning first`);
    return matches[0];
  }

  console.warn(`[clientMatcher] No client match found for: "${businessName}"`);
  return null;
}

async function logBooking(logData) {
  console.log('[clientMatcher] Logging to Supabase:', logData.processing_status || 'new entry');
  const { error } = await supabase
    .from('booking_agent_logs')
    .insert([logData]);
  if (error) {
    console.error('[clientMatcher] Supabase log error:', error);
  }
}

async function updateLog(id, updates) {
  const { error } = await supabase
    .from('booking_agent_logs')
    .update(updates)
    .eq('id', id);
  if (error) {
    console.error('[clientMatcher] Supabase update log error:', error);
  }
}

// Check if we've already processed this AgentMail message (idempotency)
async function isAlreadyProcessed(messageId) {
  const { data, error } = await supabase
    .from('booking_agent_logs')
    .select('id')
    .eq('agentmail_message_id', messageId)
    .not('processing_status', 'eq', 'failed')
    .limit(1);
  if (error) return false;
  return data && data.length > 0;
}

module.exports = { findClient, logBooking, updateLog, isAlreadyProcessed };
