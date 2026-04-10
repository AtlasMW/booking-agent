// scripts/registerWebhook.js
// Run once after deploying to Vercel to register your webhook with AgentMail
// Usage: AGENTMAIL_API_KEY=your_key VERCEL_URL=your-vercel-url.vercel.app node scripts/registerWebhook.js

const AGENTMAIL_API_KEY = process.env.AGENTMAIL_API_KEY;
const VERCEL_URL = process.env.VERCEL_URL; // e.g. booking-agent.vercel.app

if (!AGENTMAIL_API_KEY || !VERCEL_URL) {
  console.error('❌ Missing environment variables. Set AGENTMAIL_API_KEY and VERCEL_URL');
  process.exit(1);
}

const webhookUrl = `https://${VERCEL_URL}/api/webhook`;

async function registerWebhook() {
  console.log(`Registering webhook: ${webhookUrl}`);

  const res = await fetch('https://api.agentmail.to/v0/webhooks', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AGENTMAIL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: webhookUrl,
      event_types: ['message.received'], // Only fire on new incoming emails
    }),
  });

  const data = await res.json();

  if (res.ok) {
    console.log('✅ Webhook registered successfully!');
    console.log('Webhook ID:', data.id || data.webhook_id);
    console.log('URL:', webhookUrl);
    console.log('\nYour agent is now live. Forward booking emails to: atlasdrifter@agentmail.to');
  } else {
    console.error('❌ Failed to register webhook:', data);
  }
}

registerWebhook();
