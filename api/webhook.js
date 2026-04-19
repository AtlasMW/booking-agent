// api/webhook.js
// Main AgentMail webhook handler - deployed as a Vercel serverless function

const { parseBookingEmail } = require('../lib/parseEmail.js');
const { findClient, logBooking, updateLog, isAlreadyProcessed } = require('../lib/clientMatcher.js');
const {
  findContactByEmail,
  findContactFuzzy,
  findPipelineAndStage,
  findStageInPipeline,
  findOpportunityByContact,
  updateOpportunityStage,
  createAppointment,
  getCalendarTimezone,
} = require('../lib/ghl.js');

console.log('[webhook] Module loaded successfully');

module.exports = async function handler(req, res) {
  console.log('[webhook] Handler invoked, method:', req.method);

  // AgentMail will only send POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('[webhook] Payload received:', JSON.stringify(req.body).substring(0, 500));

  try {
    await processWebhook(req.body);
    res.status(200).json({ received: true, status: 'processed' });
  } catch (err) {
    console.error('[webhook] Unhandled error in processWebhook:', err);
    res.status(500).json({ received: true, error: err.message });
  }
};

async function processWebhook(payload) {
  // Verify this is a message.received event
  if (payload.event_type !== 'message.received') {
    console.log('[webhook] Ignoring non-message event:', payload.event_type);
    return;
  }

  const message = payload.message;
  if (!message) {
    console.error('[webhook] No message in payload');
    return;
  }

  const messageId = message.message_id;
  const emailSubject = message.subject || '';
  const emailBody = message.text || message.html || '';
  const fromAddress = message.from_?.[0] || '';

  console.log(`[webhook] Processing message: ${messageId} | Subject: ${emailSubject}`);

  // Idempotency check - don't process the same email twice
  if (await isAlreadyProcessed(messageId)) {
    console.log(`[webhook] Already processed message: ${messageId}, skipping`);
    return;
  }

  // Create initial log entry
  const logEntry = {
    agentmail_message_id: messageId,
    raw_email_subject: emailSubject,
    raw_email_from: fromAddress,
    processing_status: 'pending',
  };
  await logBooking(logEntry);

  // Fetch the full message if body is missing (large email protection)
  let emailText = emailBody;
  if (!emailText && messageId) {
    console.log('[webhook] No body in payload, fetching full message...');
    try {
      emailText = await fetchFullMessage(messageId);
    } catch (err) {
      console.error('[webhook] Could not fetch full message:', err);
    }
  }

  if (!emailText) {
    console.error('[webhook] No email body to process');
    await logBooking({ ...logEntry, processing_status: 'failed', error_message: 'Empty email body' });
    return;
  }

  console.log(`[webhook] Email body length: ${emailText.length} chars`);

  // STEP 1: Parse email with Claude AI
  console.log('[webhook] STEP 1: Parsing email with Claude...');
  let booking;
  try {
    booking = await parseBookingEmail(emailText, emailSubject);
  } catch (err) {
    console.error('[webhook] Claude parsing failed:', err);
    await logBooking({ ...logEntry, processing_status: 'failed', error_message: err.message });
    return;
  }

  if (!booking) {
    console.error('[webhook] Could not extract booking data from email');
    await logBooking({ ...logEntry, processing_status: 'failed', error_message: 'Parsing returned null' });
    return;
  }

  console.log('[webhook] Extracted booking:', JSON.stringify(booking, null, 2));

  // Update log with extracted data
  Object.assign(logEntry, {
    booking_type: booking.type,
    booking_source: booking.source,
    extracted_business_name: booking.businessName,
    extracted_contact_name: booking.contactName,
    extracted_contact_email: booking.contactEmail,
    extracted_contact_phone: booking.contactPhone,
    extracted_masked_email: booking.maskedEmail,
    extracted_phone_fragment: booking.phoneFragment,
    extracted_service: booking.service,
    extracted_staff: booking.staff,
    extracted_datetime: booking.datetime,
    extracted_location: booking.location,
  });

  // STEP 2: Match to a client in Supabase
  console.log(`[webhook] STEP 2: Finding client for: "${booking.businessName}"...`);
  const client = await findClient(booking.businessName, booking.location);

  if (!client) {
    console.warn(`[webhook] No client found for business: "${booking.businessName}"`);
    await logBooking({ ...logEntry, client_matched: false, processing_status: 'failed', error_message: `No client match for: ${booking.businessName}` });
    return;
  }

  console.log(`[webhook] Matched client: ${client.business_name}`);
  logEntry.client_matched = true;

  const { ghl_api_key: apiKey, ghl_location_id: locationId, ghl_calendar_id: calendarId, ghl_pipeline_id: clientPipelineId } = client;
  const stageName = booking.type === 'confirmed'
    ? client.confirmed_stage_name
    : client.cancelled_stage_name;

  console.log(`[webhook] Client pipeline ID: ${clientPipelineId || 'not set'} | Location keyword: ${client.location_keyword || 'none'}`);

  // STEP 3: Find contact in GHL using enhanced fuzzy matching
  console.log('[webhook] STEP 3: Finding contact in GHL (enhanced matching)...');
  let contact = null;

  // Use fuzzy matching which handles both Fresha (partial data) and Timely (full data)
  contact = await findContactFuzzy(apiKey, locationId, booking);

  if (contact) {
    const matchNote = contact._multipleMatches
      ? ` (WARNING: ${contact._matchCount} similar matches found — using best candidate)`
      : '';
    console.log(`[webhook] Found GHL contact: ${contact.id}${matchNote}`);
    logEntry.ghl_contact_id = contact.id;

    if (contact._multipleMatches) {
      logEntry.match_warning = `Multiple matches (${contact._matchCount}) — manual review recommended`;
    }
  } else {
    console.log('[webhook] No GHL contact found');
  }

  // STEP 4: Find and update opportunity
  let opportunityUpdated = false;
  if (contact) {
    console.log('[webhook] STEP 4: Finding opportunity...');
    const opportunity = await findOpportunityByContact(apiKey, locationId, contact.id);

    if (opportunity) {
      console.log(`[webhook] Found opportunity: ${opportunity.id} (current pipeline: ${opportunity.pipelineId})`);
      logEntry.opportunity_found = true;
      logEntry.opportunity_id = opportunity.id;

      // Use the pipeline ID from the client record if available, otherwise search
      let pipelineId = clientPipelineId;
      let stageId = null;

      if (pipelineId) {
        // Find the stage within this specific pipeline
        const stageInfo = await findPipelineAndStage(apiKey, locationId, stageName);
        if (stageInfo) {
          // Only use the stage if it belongs to our target pipeline
          if (stageInfo.pipelineId === pipelineId) {
            stageId = stageInfo.stageId;
          } else {
            // Stage name exists but in wrong pipeline — search the correct one
            const allStages = await findStageInPipeline(apiKey, locationId, pipelineId, stageName);
            if (allStages) {
              stageId = allStages.stageId;
            }
          }
        }
      } else {
        // No pipeline ID stored — fall back to searching all pipelines
        const stageInfo = await findPipelineAndStage(apiKey, locationId, stageName);
        if (stageInfo) {
          pipelineId = stageInfo.pipelineId;
          stageId = stageInfo.stageId;
        }
      }

      if (pipelineId && stageId) {
        opportunityUpdated = await updateOpportunityStage(apiKey, opportunity.id, pipelineId, stageId);
        console.log(`[webhook] Opportunity stage updated: ${opportunityUpdated} (pipeline: ${pipelineId})`);
        logEntry.opportunity_updated = opportunityUpdated;
      } else {
        console.warn(`[webhook] Could not find stage "${stageName}" in pipeline ${pipelineId}`);
        logEntry.error_message = `Pipeline stage not found: ${stageName}`;
      }
    } else {
      console.log('[webhook] No opportunity found for contact — skipping pipeline update');
      logEntry.opportunity_found = false;
    }
  }

  // STEP 5: Create calendar appointment
  console.log('[webhook] STEP 5: Creating appointment...');
  let appointmentCreated = false;

  // Use timezone from client record in Supabase
  const timezone = client.timezone || null;
  console.log(`[webhook] Client timezone: ${timezone}`);

  if (contact) {
    const appointmentId = await createAppointment(apiKey, locationId, calendarId, contact.id, booking, timezone);

    if (appointmentId) {
      console.log(`[webhook] Appointment created: ${appointmentId}`);
      logEntry.appointment_created = true;
      logEntry.ghl_appointment_id = appointmentId;
      appointmentCreated = true;
    } else {
      console.warn('[webhook] Appointment creation failed');
      logEntry.error_message = (logEntry.error_message || '') + ' | Appointment creation failed';
    }
  } else {
    console.warn('[webhook] Skipping appointment creation — no contact found in GHL');
    logEntry.error_message = 'No GHL contact found; appointment and pipeline update skipped';
  }

  // STEP 6: Final status
  let status;
  if (appointmentCreated && opportunityUpdated) {
    status = 'success';
  } else if (appointmentCreated || opportunityUpdated) {
    status = 'partial';
  } else if (logEntry.client_matched) {
    status = 'partial';
  } else {
    status = 'failed';
  }

  logEntry.processing_status = status;
  await logBooking(logEntry);
  console.log(`[webhook] Processing complete. Status: ${status}`);
}

// Fetch full message from AgentMail API (for large emails)
async function fetchFullMessage(messageId) {
  console.log('[webhook] Fetching full message from AgentMail:', messageId);
  const res = await fetch(`https://api.agentmail.to/v0/messages/${messageId}`, {
    headers: {
      'Authorization': `Bearer ${process.env.AGENTMAIL_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.text || data?.html || null;
}
