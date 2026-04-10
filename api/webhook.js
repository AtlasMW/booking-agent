// api/webhook.js
// Main AgentMail webhook handler - deployed as a Vercel serverless function

import { parseBookingEmail } from '../lib/parseEmail.js';
import { findClient, logBooking, updateLog, isAlreadyProcessed } from '../lib/clientMatcher.js';
import {
  findContactByEmail,
  findContactByName,
  findPipelineAndStage,
  findOpportunityByContact,
  updateOpportunityStage,
  createAppointment,
} from '../lib/ghl.js';

export default async function handler(req, res) {
  // AgentMail will only send POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ✅ Return 200 immediately so AgentMail doesn't retry
  // We process in the background
  res.status(200).json({ received: true });

  // Now process asynchronously
  try {
    await processWebhook(req.body);
  } catch (err) {
    console.error('Unhandled error in processWebhook:', err);
  }
}

async function processWebhook(payload) {
  // Verify this is a message.received event
  if (payload.event_type !== 'message.received') {
    console.log('Ignoring non-message event:', payload.event_type);
    return;
  }

  const message = payload.message;
  if (!message) {
    console.error('No message in payload');
    return;
  }

  const messageId = message.message_id;
  const emailSubject = message.subject || '';
  const emailBody = message.text || message.html || '';
  const fromAddress = message.from_?.[0] || '';

  console.log(`Processing message: ${messageId} | Subject: ${emailSubject}`);

  // Idempotency check - don't process the same email twice
  if (await isAlreadyProcessed(messageId)) {
    console.log(`Already processed message: ${messageId}, skipping`);
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
    try {
      emailText = await fetchFullMessage(messageId);
    } catch (err) {
      console.error('Could not fetch full message:', err);
    }
  }

  if (!emailText) {
    console.error('No email body to process');
    await logBooking({ ...logEntry, processing_status: 'failed', error_message: 'Empty email body' });
    return;
  }

  // STEP 1: Parse email with Claude AI
  console.log('Parsing email with Claude...');
  let booking;
  try {
    booking = await parseBookingEmail(emailText, emailSubject);
  } catch (err) {
    console.error('Claude parsing failed:', err);
    await logBooking({ ...logEntry, processing_status: 'failed', error_message: err.message });
    return;
  }

  if (!booking) {
    console.error('Could not extract booking data from email');
    await logBooking({ ...logEntry, processing_status: 'failed', error_message: 'Parsing returned null' });
    return;
  }

  console.log('Extracted booking:', JSON.stringify(booking, null, 2));

  // Update log with extracted data
  Object.assign(logEntry, {
    booking_type: booking.type,
    extracted_business_name: booking.businessName,
    extracted_contact_name: booking.contactName,
    extracted_contact_email: booking.contactEmail,
    extracted_contact_phone: booking.contactPhone,
    extracted_service: booking.service,
    extracted_staff: booking.staff,
    extracted_datetime: booking.datetime,
    extracted_location: booking.location,
  });

  // STEP 2: Match to a client in Supabase
  console.log(`Finding client for: "${booking.businessName}"...`);
  const client = await findClient(booking.businessName);

  if (!client) {
    console.warn(`No client found for business: "${booking.businessName}"`);
    await logBooking({ ...logEntry, client_matched: false, processing_status: 'failed', error_message: `No client match for: ${booking.businessName}` });
    return;
  }

  console.log(`Matched client: ${client.business_name}`);
  logEntry.client_matched = true;

  const { ghl_api_key: apiKey, ghl_location_id: locationId, ghl_calendar_id: calendarId } = client;
  const stageName = booking.type === 'confirmed'
    ? client.confirmed_stage_name
    : client.cancelled_stage_name;

  // STEP 3: Find contact in GHL
  let contact = null;
  if (booking.contactEmail) {
    contact = await findContactByEmail(apiKey, locationId, booking.contactEmail);
  }
  if (!contact && booking.contactName) {
    contact = await findContactByName(apiKey, locationId, booking.contactName);
  }

  if (contact) {
    console.log(`Found GHL contact: ${contact.id}`);
    logEntry.ghl_contact_id = contact.id;
  } else {
    console.log('No GHL contact found — will still create appointment');
  }

  // STEP 4: Find and update opportunity (only if contact found)
  let opportunityUpdated = false;
  if (contact) {
    const opportunity = await findOpportunityByContact(apiKey, locationId, contact.id);

    if (opportunity) {
      console.log(`Found opportunity: ${opportunity.id}`);
      logEntry.opportunity_found = true;
      logEntry.opportunity_id = opportunity.id;

      // Find the pipeline stage ID
      const stageInfo = await findPipelineAndStage(apiKey, locationId, stageName);

      if (stageInfo) {
        opportunityUpdated = await updateOpportunityStage(apiKey, opportunity.id, stageInfo.pipelineId, stageInfo.stageId);
        console.log(`Opportunity stage updated: ${opportunityUpdated}`);
        logEntry.opportunity_updated = opportunityUpdated;
      } else {
        console.warn(`Stage not found: "${stageName}"`);
        logEntry.error_message = `Pipeline stage not found: ${stageName}`;
      }
    } else {
      console.log('No opportunity found — skipping pipeline update');
      logEntry.opportunity_found = false;
    }
  }

  // STEP 5: Create calendar appointment
  // We need a contactId - use found contact or skip gracefully
  let appointmentCreated = false;
  if (contact) {
    const appointmentId = await createAppointment(apiKey, locationId, calendarId, contact.id, {
      ...booking,
      contactName: booking.contactName,
    });

    if (appointmentId) {
      console.log(`Appointment created: ${appointmentId}`);
      logEntry.appointment_created = true;
      logEntry.ghl_appointment_id = appointmentId;
      appointmentCreated = true;
    } else {
      console.warn('Appointment creation failed');
      logEntry.error_message = (logEntry.error_message || '') + ' | Appointment creation failed';
    }
  } else {
    console.warn('Skipping appointment creation — no contact found in GHL');
    logEntry.error_message = 'No GHL contact found; appointment skipped';
  }

  // STEP 6: Final status
  const status = appointmentCreated ? 'success' : (logEntry.client_matched ? 'partial' : 'failed');
  logEntry.processing_status = status;

  await logBooking(logEntry);
  console.log(`✅ Processing complete. Status: ${status}`);
}

// Fetch full message from AgentMail API (for large emails)
async function fetchFullMessage(messageId) {
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
