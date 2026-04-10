// lib/ghl.js
// Go High Level API v2 helper functions

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

function ghlHeaders(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Version': GHL_VERSION,
  };
}

// Search for a contact by email in a sub-account
async function findContactByEmail(apiKey, locationId, email) {
  console.log('[ghl] findContactByEmail:', email);
  const url = `${GHL_BASE}/contacts/search/duplicate?locationId=${locationId}&email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) {
    console.error('[ghl] findContactByEmail error:', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  return data?.contact || null;
}

// Search for a contact by name if email search fails
async function findContactByName(apiKey, locationId, name) {
  console.log('[ghl] findContactByName:', name);
  const url = `${GHL_BASE}/contacts/?locationId=${locationId}&query=${encodeURIComponent(name)}&limit=5`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) {
    console.error('[ghl] findContactByName error:', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const contacts = data?.contacts || [];
  return contacts.length > 0 ? contacts[0] : null;
}

// Get all pipelines for a location, find the one with our stage names
async function findPipelineAndStage(apiKey, locationId, stageName) {
  console.log('[ghl] findPipelineAndStage:', stageName);
  const url = `${GHL_BASE}/opportunities/pipelines?locationId=${locationId}`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) {
    console.error('[ghl] findPipelineAndStage error:', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const pipelines = data?.pipelines || [];

  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages || []) {
      if (stage.name === stageName) {
        return { pipelineId: pipeline.id, stageId: stage.id, stageName: stage.name };
      }
    }
  }
  return null;
}

// Search for an opportunity by contact ID
async function findOpportunityByContact(apiKey, locationId, contactId) {
  console.log('[ghl] findOpportunityByContact:', contactId);
  const url = `${GHL_BASE}/opportunities/search?location_id=${locationId}&contact_id=${contactId}&limit=5`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) {
    console.error('[ghl] findOpportunityByContact error:', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const opps = data?.opportunities || [];
  // Return the most recent opportunity
  return opps.length > 0 ? opps[0] : null;
}

// Update an opportunity's pipeline stage
async function updateOpportunityStage(apiKey, opportunityId, pipelineId, stageId) {
  console.log('[ghl] updateOpportunityStage:', opportunityId);
  const url = `${GHL_BASE}/opportunities/${opportunityId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: ghlHeaders(apiKey),
    body: JSON.stringify({ pipelineId, pipelineStageId: stageId }),
  });
  if (!res.ok) {
    console.error('[ghl] updateOpportunityStage error:', res.status, await res.text());
    return false;
  }
  return true;
}

// Create a calendar appointment
async function createAppointment(apiKey, locationId, calendarId, contactId, booking) {
  console.log('[ghl] createAppointment for contact:', contactId);
  // Parse the booking datetime into ISO format
  // booking.datetime is like "Monday, 13 Apr 2026, 10:00am"
  const startTime = parseBookingDateTime(booking.datetime);
  if (!startTime) {
    console.error('[ghl] Could not parse booking datetime:', booking.datetime);
    return null;
  }

  // Default appointment duration: 60 minutes
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

  const payload = {
    calendarId,
    locationId,
    contactId,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    title: `${booking.service || 'Appointment'} - ${booking.contactName}`,
    appointmentStatus: booking.type === 'confirmed' ? 'confirmed' : 'cancelled',
    address: booking.location || '',
    notes: `Booked via: ${booking.staff ? 'Staff: ' + booking.staff : ''} | Auto-synced by Booking Agent`,
  };

  console.log('[ghl] Appointment payload:', JSON.stringify(payload));
  const url = `${GHL_BASE}/calendars/events/appointments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: ghlHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error('[ghl] createAppointment error:', res.status, await res.text());
    return null;
  }

  const data = await res.json();
  return data?.appointment?.id || data?.id || null;
}

// Parse various datetime formats from booking emails
function parseBookingDateTime(datetimeStr) {
  if (!datetimeStr) return null;
  try {
    // Handle "Monday, 13 Apr 2026, 10:00am" format
    const cleaned = datetimeStr
      .replace(/(\d+)(am|pm)/i, '$1 $2')
      .replace(/,\s*(\d+\s+\w+\s+\d+)/, ' $1');
    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) return parsed;

    // Fallback: try direct parse
    const direct = new Date(datetimeStr);
    if (!isNaN(direct.getTime())) return direct;

    return null;
  } catch {
    return null;
  }
}

module.exports = {
  findContactByEmail,
  findContactByName,
  findPipelineAndStage,
  findOpportunityByContact,
  updateOpportunityStage,
  createAppointment,
};
