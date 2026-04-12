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

// Fetch full contact details by ID
async function getContactById(apiKey, contactId) {
  const url = `${GHL_BASE}/contacts/${contactId}`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) {
    console.error('[ghl] getContactById error:', res.status);
    return null;
  }
  const data = await res.json();
  return data?.contact || null;
}

// Enhanced contact matching using partial data from Fresha
// Matches first name + last initial, then confirms with partial phone/email
// Prioritizes contacts with real data and existing opportunities
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

  // STEP B: If we have a full phone (Timely), search by phone
  if (contactPhone) {
    console.log('[ghl] Trying exact phone match:', contactPhone);
    const url = `${GHL_BASE}/contacts/search/duplicate?locationId=${locationId}&number=${encodeURIComponent(contactPhone)}`;
    const res = await fetch(url, { headers: ghlHeaders(apiKey) });
    if (res.ok) {
      const data = await res.json();
      if (data?.contact) {
        console.log('[ghl] Exact phone match found:', data.contact.id);
        return data.contact;
      }
    }
  }

  // STEP C: Search by name with fuzzy matching
  if (!contactName) return null;

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

  // STEP D: Fetch full details for each candidate (search results may not include phone/email)
  const fullContacts = [];
  for (const c of contacts) {
    const full = await getContactById(apiKey, c.id);
    if (full) {
      fullContacts.push(full);
    }
  }

  console.log(`[ghl] Fetched full details for ${fullContacts.length} contacts`);

  // STEP E: Score each candidate
  const scored = fullContacts.map(c => {
    let score = 0;
    const cFirstName = (c.firstName || c.name?.split(/\s+/)[0] || '').toLowerCase();
    const cLastName = (c.lastName || '').toLowerCase();
    const cEmail = (c.email || '').toLowerCase();
    const cPhone = (c.phone || '').replace(/\D/g, '');

    // First name match
    if (cFirstName === firstName.toLowerCase()) {
      score += 10;
    }

    // Last initial match — check against last name
    if (lastInitial && lastInitial.length === 1) {
      if (cLastName.startsWith(lastInitial.toLowerCase())) {
        score += 5;
      }
    }

    // Phone fragment match (e.g. "449" matches end of phone)
    if (phoneFragment && cPhone && cPhone.endsWith(phoneFragment)) {
      score += 20;
      console.log(`[ghl]   Contact ${c.id} (${cFirstName}) phone ends with "${phoneFragment}" ✓`);
    }

    // Masked email match (e.g. "hadg" matches start of email)
    if (maskedEmail && cEmail && cEmail.startsWith(maskedEmail.toLowerCase())) {
      score += 20;
      console.log(`[ghl]   Contact ${c.id} (${cFirstName}) email starts with "${maskedEmail}" ✓`);
    }

    // Prefer contacts that have real data (not empty shells)
    if (cEmail) score += 3;
    if (cPhone) score += 3;

    // Full phone match (Timely)
    if (contactPhone && cPhone) {
      const cleanInput = contactPhone.replace(/\D/g, '');
      if (cPhone === cleanInput || cPhone.endsWith(cleanInput) || cleanInput.endsWith(cPhone)) {
        score += 25;
      }
    }

    // Full email match (Timely)
    if (contactEmail && cEmail === contactEmail.toLowerCase()) {
      score += 25;
    }

    return { contact: c, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Log top candidates
  scored.slice(0, 5).forEach((s, i) => {
    const name = `${s.contact.firstName || ''} ${s.contact.lastName || ''}`.trim();
    const email = s.contact.email || 'no email';
    const phone = s.contact.phone || 'no phone';
    console.log(`[ghl]   Candidate ${i + 1}: ${name} | ${email} | ${phone} | score=${s.score}`);
  });

  // Filter to only candidates with a meaningful score
  const threshold = 10; // At minimum must match first name
  const viable = scored.filter(s => s.score >= threshold);

  if (viable.length === 0) {
    console.log('[ghl] No viable matches above threshold');
    return null;
  }

  // If top candidate has a significantly higher score, use it confidently
  if (viable.length === 1 || (viable.length > 1 && viable[0].score > viable[1].score + 5)) {
    console.log(`[ghl] Confident match: ${viable[0].contact.id} (score: ${viable[0].score})`);
    return viable[0].contact;
  }

  // Multiple candidates with similar scores — check for opportunities to break the tie
  console.log(`[ghl] ${viable.length} candidates with similar scores — checking opportunities to break tie`);
  for (const v of viable) {
    const opp = await findOpportunityByContact(apiKey, locationId, v.contact.id);
    if (opp) {
      console.log(`[ghl] Tie-breaker: contact ${v.contact.id} has opportunity ${opp.id} — selecting this one`);
      return v.contact;
    }
  }

  // Still tied — return best but flag it
  console.warn(`[ghl] Multiple matches (${viable.length}) with no clear winner — returning best candidate`);
  return { ...viable[0].contact, _multipleMatches: true, _matchCount: viable.length };
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

// Find a specific stage within a specific pipeline
async function findStageInPipeline(apiKey, locationId, pipelineId, stageName) {
  console.log('[ghl] findStageInPipeline:', pipelineId, '| stage:', stageName);
  const url = `${GHL_BASE}/opportunities/pipelines?locationId=${locationId}`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) {
    console.error('[ghl] findStageInPipeline error:', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const pipelines = data?.pipelines || [];

  const pipeline = pipelines.find(p => p.id === pipelineId);
  if (!pipeline) {
    console.error('[ghl] Pipeline not found:', pipelineId);
    return null;
  }

  for (const stage of pipeline.stages || []) {
    if (stage.name === stageName) {
      console.log(`[ghl] Found stage "${stageName}" in pipeline ${pipelineId}: ${stage.id}`);
      return { pipelineId: pipeline.id, stageId: stage.id, stageName: stage.name };
    }
  }

  console.warn(`[ghl] Stage "${stageName}" not found in pipeline ${pipelineId}`);
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

// Fetch calendar details from GHL to get timezone
async function getCalendarTimezone(apiKey, locationId, calendarId) {
  console.log('[ghl] getCalendarTimezone for calendar:', calendarId);
  const url = `${GHL_BASE}/calendars/${calendarId}`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) {
    console.error('[ghl] getCalendarTimezone error:', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  // Try multiple possible response paths
  const timezone = data?.calendar?.timezone
    || data?.timezone
    || data?.calendar?.calendarConfig?.timezone
    || data?.calendarConfig?.timezone
    || null;

  if (!timezone) {
    // Log the response structure so we can find the right path
    console.log('[ghl] Calendar API response keys:', JSON.stringify(Object.keys(data)));
    if (data?.calendar) {
      console.log('[ghl] Calendar object keys:', JSON.stringify(Object.keys(data.calendar)));
    }
    // Log a sample of the data to find timezone field
    console.log('[ghl] Calendar data sample:', JSON.stringify(data).substring(0, 500));
  }

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

    if (res.status === 400 && errText.includes('slot')) {
      console.warn('[ghl] Slot unavailable — appointment may be in the past or conflicting');
    }
    return null;
  }

  const data = await res.json();
  return data?.appointment?.id || data?.id || null;
}

// IANA timezone offset map for common Australian timezones
const TIMEZONE_OFFSETS = {
  'Australia/Brisbane': 10,
  'Australia/Sydney': 10,
  'Australia/Melbourne': 10,
  'Australia/Perth': 8,
  'Australia/Adelaide': 9.5,
  'Australia/Darwin': 9.5,
  'Australia/Hobart': 10,
  'Pacific/Auckland': 12,
  'America/New_York': -5,
  'America/Chicago': -6,
  'America/Los_Angeles': -8,
  'Europe/London': 0,
};

// Parse various datetime formats from booking emails with timezone support
function parseBookingDateTime(datetimeStr, timezone) {
  if (!datetimeStr) return null;
  console.log('[ghl] Parsing datetime:', datetimeStr, '| timezone:', timezone);

  try {
    let cleaned = datetimeStr
      .replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, '')
      .replace(/,\s*/g, ' ')
      .trim();

    // Normalize am/pm: "9:00am" -> "9:00 AM"
    cleaned = cleaned.replace(/(\d+:\d+)\s*(am|pm)/i, '$1 $2');

    let parsed = new Date(cleaned);

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
    if (timezone) {
      try {
        const utcDate = new Date(Date.UTC(
          parsed.getFullYear(),
          parsed.getMonth(),
          parsed.getDate(),
          parsed.getHours(),
          parsed.getMinutes(),
          0
        ));

        const offset = getTimezoneOffset(timezone, utcDate);
        if (offset !== null) {
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
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (tzPart) {
      const match = tzPart.value.match(/GMT([+-]?)(\d+)(?::(\d+))?/);
      if (match) {
        const sign = match[1] === '-' ? -1 : 1;
        const hours = parseInt(match[2]);
        const minutes = match[3] ? parseInt(match[3]) : 0;
        return sign * (hours + minutes / 60);
      }
    }
  } catch {
    // Intl not available
  }

  if (TIMEZONE_OFFSETS[timezone] !== undefined) {
    console.log('[ghl] Using fallback timezone offset for:', timezone);
    return TIMEZONE_OFFSETS[timezone];
  }

  console.warn('[ghl] Unknown timezone:', timezone);
  return null;
}

module.exports = {
  findContactByEmail,
  findContactFuzzy,
  findPipelineAndStage,
  findStageInPipeline,
  findOpportunityByContact,
  updateOpportunityStage,
  createAppointment,
  getCalendarTimezone,
};
