// lib/parseEmail.js
// Uses Claude AI to extract structured booking data from raw emails

async function parseBookingEmail(emailText, emailSubject) {
  const prompt = `You are a booking data extraction agent. Extract structured information from this booking confirmation or cancellation email.

Email Subject: ${emailSubject || '(no subject)'}

Email Body:
${emailText}

Extract and return ONLY valid JSON (no markdown, no explanation) with this exact structure:
{
  "type": "confirmed" or "cancelled",
  "source": "fresha" or "timely" or "unknown",
  "businessName": "the spa/clinic/business name",
  "contactName": "customer full name as shown (e.g. 'Helen H')",
  "contactEmail": "customer email address or null if not available",
  "contactPhone": "customer phone number or null if not available",
  "maskedEmail": "masked email prefix if present (e.g. 'hadg' from 'hadg*****') or null",
  "phoneFragment": "last digits of phone if partially masked (e.g. '449' from '***** 449') or null",
  "service": "the service/treatment booked",
  "staff": "staff member name or null",
  "datetime": "the appointment date and time exactly as written in the email",
  "duration": "duration in minutes if mentioned, or null",
  "location": "the physical address or location name",
  "confidence": "high", "medium", or "low"
}

Rules:
- businessName: Look for the business/spa name, NOT the service name
- source: Set to "fresha" if email mentions Fresha or is from fresha.com, "timely" if from Timely or gettimely.com, otherwise "unknown"
- For Fresha emails: customer details are often masked. Extract the visible prefix of the email (before the asterisks) into maskedEmail, and any trailing digits of the phone into phoneFragment
- For Timely emails: full email and phone are usually provided, so use contactEmail and contactPhone directly
- maskedEmail should contain ONLY the visible characters before the asterisks (e.g. "hadg" not "hadg*****")
- phoneFragment should contain ONLY the visible digits (e.g. "449" not "***** 449")
- If the email is a cancellation, set type to "cancelled"
- If any field is truly not present, use null
- Return ONLY the JSON object, nothing else`;

  console.log('[parseEmail] Calling Claude API...');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('[parseEmail] Claude API error:', response.status, errText);
    throw new Error(`Claude API error: ${response.status}`);
  }

  const data = await response.json();
  console.log('[parseEmail] Claude response received');

  const text = data.content?.[0]?.text || '';

  try {
    // Strip any accidental markdown fences
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    console.log('[parseEmail] Successfully parsed booking data');
    return parsed;
  } catch {
    console.error('[parseEmail] Failed to parse Claude response as JSON:', text);
    return null;
  }
}

module.exports = { parseBookingEmail };
