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
  const url = `${GHL_BASE}/contacts/?locationId=${locationId}&query=${encodeURIComponent(name)}&limit=20`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) {
    console.error('[ghl] findContactByName error:', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const contacts = data?.contacts || [];
  return contacts.length > 0 ? contacts : null;
}

// Enhanced contact matching using partial data from Fresha
// Matches first name + last initial, then confirms with partial phone/email
async function findContactFuzzy(apiKey, locationId, booking) {
  const { contactName, contactEmail, contactPhone, maskedEmail, phoneFragment } = booking;

  // STEP A: If we have a full email (Timely), search by email first
  if (contactEmail) {
    console.log('[ghl] Trying exact email match:', contactEmail);
    const contact = await findContactByEmail(apiKey, locationId, contactEmail);
    if (contact) {
      console.log('[ghl] Exact email match found:', contact.id);
      return contact;
    }
  }

  // STEP B: Search by name
  if (!contactName) return null;

  // Extract first name for broader search
  const nameParts = contactName.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastInitial = nameParts.length > 1 ? nameParts[nameParts.length - 1] : null;

  console.log('[ghl] Fuzzy matching - firstName:', firstName, 'lastInitial:', lastInitial);

  // Search GHL by first name
  const url = `${GHL_BASE}/contacts/?locationId=${locationId}&query=${encodeURIComponent(firstName)}&limit=20`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) {
    console.error('[ghl] findContactFuzzy search error:', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const contacts = data?.contacts || [];

  if (contacts.length === 0) {
    console.log('[ghl] No contacts found for first name:', firstName);
    return null;
  }

  console.log(`[ghl] Found ${contacts.length} contacts matching "${firstName}"`);

  // STEP C: Filter by last name initial if available
  let candidates = contacts;
  if (lastInitial && lastInitial.length === 1) {
    candidates = contacts.filter(c => {
      const cLastName = (c.lastName || c.name?.split(/\s+/).pop() || '').trim();
      return cLastName.toLowerCase().startsWith(lastInitial.toLowerCase());
    });
    console.log(`[ghl] After last initial "${lastInitial}" filter: ${candidates.length} candidates`);

    // If no candidates match the initial, fall back to all contacts
    if (candidates.length === 0) {
      candidates = contacts;
    }
  }

  // If only one candidate, return it
  if (candidates.length === 1) {
    console.log('[ghl] Single match found:', candidates[0].id);
    return candidates[0];
  }

  // STEP D: Narrow down using partial phone match
  if (phoneFragment && candidates.length > 1) {
    const phoneMatches = candidates.filter(c => {
      const phone = (c.phone || '').replace(/\D/g, '');
      return phone.endsWith(phoneFragment);
    });
    console.log(`[ghl] After phone fragment "${phoneFragment}" filter: ${phoneMatches.length} matches`);
    if (phoneMatches.length === 1) {
      console.log('[ghl] Phone fragment confirmed match:', phoneMatches[0].id);
      return phoneMatches[0];
    }
    if (phoneMatches.length > 0) {
      candidates = phoneMatches;
    }
  }

  // STEP E: Narrow down using masked email prefix
  if (maskedEmail && candidates.length > 1) {
    const emailMatches = candidates.filter(c => {
      const email = (c.email || '').toLowerCase();
      return email.startsWith(maskedEmail.toLowerCase());
    });
    console.log(`[ghl] After masked email "${maskedEmail}" filter: ${emailMatches.length} matches`);
    if (emailMatches.length === 1) {
      console.log('[ghl] Masked email confirmed match:', emailMatches[0].id);
      return emailMatches[0];
    }
    if (emailMatches.length > 0) {
      candidates = emailMatches;
    }
  }

  // STEP F: If we still have multiple candidates or exactly one, return best match
  if (candidates.length === 1) {
    console.log('[ghl] Final single match:', candidates[0].id);
    return candidates[0];
  }

  if (candidates.length > 1) {
    console.warn(`[ghl] Multiple matches (${candidates.length}) found — returning best candidate`);
    // Return the first one but flag it
    return { ...candidates[0], _multipleMatches: true, _matchCount: candidates.length };
  }

  console.log('[ghl] No fuzzy match found');
  return null;
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

// Search for opportunities by contact ID
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

// Fetch calendar timezone from GHL
async function getCalendarTimezone(apiKey, locationId, calendarId) {
  console.log('[ghl] getCalendarTimezone for calendar:', calendarId);
  const url = `${GHL_BASE}/calendars/${calendarId}`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) {
    console.error('[ghl] getCalendarTimezone error:', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const timezone = data?.calendar?.timezone || data?.timezone || null;
  console.log('[ghl] Calendar timezone:', timezone);
  return timezone;
}

// Create a calendar appointment
async function createAppointment(apiKey, locationId, calendarId, contactId, booking, timezone) {
  console.log('[ghl] createAppointment for contact:', contactId);

  // Parse the booking datetime with timezone awareness
  const startTime = parseBookingDateTime(booking.datetime, timezone);
  if (!startTime) {
    console.error('[ghl] Could not parse booking datetime:', booking.datetime);
    return null;
  }

  // Use duration from booking if available, default to 60 minutes
  const durationMinutes = booking.duration ? parseInt(booking.duration) : 60;
  const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

  const payload = {
    calendarId,
    locationId,
    contactId,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    title: `${booking.service || 'Appointment'} - ${booking.contactName}`,
    appointmentStatus: booking.type === 'confirmed' ? 'confirmed' : 'cancelled',
    address: booking.location || '',
    notes: `Booked via: ${booking.staff ? 'Staff: ' + booking.staff : ''} | Source: ${booking.source || 'unknown'} | Auto-synced by Booking Agent`,
  };

  console.log('[ghl] Appointment payload:', JSON.stringify(payload));
  const url = `${GHL_BASE}/calendars/events/appointments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: ghlHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[ghl] createAppointment error:', res.status, errText);

    // If slot unavailable (past date or conflict), log but don't fail hard
    if (res.status === 400 && errText.includes('slot')) {
      console.warn('[ghl] Slot unavailable — appointment may be in the past or conflicting');
    }
    return null;
  }

  const data = await res.json();
  return data?.appointment?.id || data?.id || null;
}

// IANA timezone offset map for common Australian timezones
// Used as fallback when Intl is not available
const TIMEZONE_OFFSETS = {
  'Australia/Brisbane': 10,
  'Australia/Sydney': 10,    // Note: doesn't handle DST
  'Australia/Melbourne': 10, // Note: doesn't handle DST
  'Australia/Perth': 8,
  'Australia/Adelaide': 9.5, // Note: doesn't handle DST
  'Australia/Darwin': 9.5,
  'Australia/Hobart': 10,    // Note: doesn't handle DST
  'Pacific/Auckland': 12,    // Note: doesn't handle DST
  'America/New_York': -5,    // Note: doesn't handle DST
  'America/Chicago': -6,     // Note: doesn't handle DST
  'America/Los_Angeles': -8, // Note: doesn't handle DST
  'Europe/London': 0,        // Note: doesn't handle DST
};

// Parse various datetime formats from booking emails with timezone support
function parseBookingDateTime(datetimeStr, timezone) {
  if (!datetimeStr) return null;
  console.log('[ghl] Parsing datetime:', datetimeStr, '| timezone:', timezone);

  try {
    // Clean up the datetime string
    // Handle formats like "Saturday, 11 Apr 2026, 9:00am" or "Thu, 23 Apr 2026 5:30PM"
    let cleaned = datetimeStr
      .replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, '')
      .replace(/,\s*/g, ' ')
      .trim();

    // Normalize am/pm: "9:00am" -> "9:00 AM"
    cleaned = cleaned.replace(/(\d+:\d+)\s*(am|pm)/i, '$1 $2');

    // Try parsing with Date constructor
    let parsed = new Date(cleaned);

    // If that fails, try rearranging "11 Apr 2026 9:00 AM" format
    if (isNaN(parsed.getTime())) {
      const match = cleaned.match(/(\d{1,2})\s+(\w{3,})\s+(\d{4})\s+(\d{1,2}:\d{2})\s*(AM|PM)?/i);
      if (match) {
        const [, day, month, year, time, ampm] = match;
        parsed = new Date(`${month} ${day}, ${year} ${time} ${ampm || ''}`);
      }
    }

    if (isNaN(parsed.getTime())) {
      console.error('[ghl] Could not parse datetime:', datetimeStr);
      return null;
    }

    // Apply timezone correction
    // The parsed date is interpreted as local/UTC — we need to convert from the calendar's timezone to UTC
    if (timezone) {
      try {
        // Get the offset for the target timezone at the parsed date
        // We construct a date string and use Intl to find the offset
        const utcDate = new Date(Date.UTC(
          parsed.getFullYear(),
          parsed.getMonth(),
          parsed.getDate(),
          parsed.getHours(),
          parsed.getMinutes(),
          0
        ));

        // Calculate the timezone offset
        const offset = getTimezoneOffset(timezone, utcDate);
        if (offset !== null) {
          // Subtract the offset to convert local time to UTC
          const corrected = new Date(utcDate.getTime() - offset * 60 * 60 * 1000);
          console.log('[ghl] Timezone corrected:', datetimeStr, '->', corrected.toISOString(), `(${timezone}, offset: ${offset}h)`);
          return corrected;
        }
      } catch (tzErr) {
        console.warn('[ghl] Timezone correction failed:', tzErr.message);
      }
    }

    console.log('[ghl] Parsed datetime (no timezone correction):', parsed.toISOString());
    return parsed;
  } catch {
    console.error('[ghl] DateTime parse error for:', datetimeStr);
    return null;
  }
}

// Get timezone offset in hours for a given IANA timezone
function getTimezoneOffset(timezone, date) {
  try {
    // Try using Intl.DateTimeFormat to get accurate offset including DST
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (tzPart) {
      // Parse "GMT+10", "GMT-5", "GMT+9:30" etc.
      const match = tzPart.value.match(/GMT([+-]?)(\d+)(?::(\d+))?/);
      if (match) {
        const sign = match[1] === '-' ? -1 : 1;
        const hours = parseInt(match[2]);
        const minutes = match[3] ? parseInt(match[3]) : 0;
        return sign * (hours + minutes / 60);
      }
    }
  } catch {
    // Intl not available or timezone not recognized
  }

  // Fallback to static offset map
  if (TIMEZONE_OFFSETS[timezone] !== undefined) {
    console.log('[ghl] Using fallback timezone offset for:', timezone);
    return TIMEZONE_OFFSETS[timezone];
  }

  console.warn('[ghl] Unknown timezone:', timezone);
  return null;
}

module.exports = {
  findContactByEmail,
  findContactByName,
  findContactFuzzy,
  findPipelineAndStage,
  findOpportunityByContact,
  updateOpportunityStage,
  createAppointment,
  getCalendarTimezone,
};
