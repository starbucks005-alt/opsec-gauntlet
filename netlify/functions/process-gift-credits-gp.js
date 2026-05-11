/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Gift Credits processor

   Two entry points, one function:
     A) Stripe webhook (stripe-signature header present):
        Handles payment_intent.succeeded → credits recipient (or queues pending)
     B) Client call (Bearer JWT):
        Validates gift metadata → creates Stripe PaymentIntent → returns client_secret

   Required Netlify env vars:
     STRIPE_SECRET_KEY          sk_live_...
     STRIPE_WEBHOOK_SECRET      whsec_...
     SUPABASE_URL
     SUPABASE_SERVICE_ROLE_KEY

   Required Supabase tables (run once in SQL Editor):

     CREATE TABLE gift_transactions (
       id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
       giver_id            UUID REFERENCES auth.users(id),
       recipient_email     TEXT NOT NULL,
       gift_type           TEXT NOT NULL,
       credits_amount      INTEGER,
       plan_tier           TEXT,
       duration_months     INTEGER,
       amount_usd          NUMERIC(10,2),
       price_paid_cents    INTEGER NOT NULL,
       ecard_cover_id      TEXT DEFAULT 'classic',
       message             TEXT,
       stripe_payment_intent TEXT UNIQUE NOT NULL,
       status              TEXT DEFAULT 'pending',
       created_at          TIMESTAMPTZ DEFAULT NOW(),
       claimed_at          TIMESTAMPTZ,
       expires_at          TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '90 days')
     );
     CREATE INDEX ON gift_transactions (recipient_email);
     CREATE INDEX ON gift_transactions (giver_id);
     ALTER TABLE gift_transactions ENABLE ROW LEVEL SECURITY;

     CREATE TABLE pending_credit_balances (
       id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
       recipient_email       TEXT NOT NULL,
       credit_amount         INTEGER NOT NULL,
       gift_transaction_id   UUID REFERENCES gift_transactions(id),
       status                TEXT DEFAULT 'pending',
       created_at            TIMESTAMPTZ DEFAULT NOW(),
       claimed_at            TIMESTAMPTZ
     );
     CREATE INDEX ON pending_credit_balances (recipient_email);
     ALTER TABLE pending_credit_balances ENABLE ROW LEVEL SECURITY;
   ───────────────────────────────────────────────────────────────────────────── */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Server-authoritative price table — client-supplied price_usd is ignored
const CREDIT_PACK_PRICES = { 50: 900, 100: 1500, 250: 2900, 500: 5500, 1000: 9900 };
const SUB_MONTHLY_PRICES = { starter: 1900, professional: 4900, studio: 11900 };
const SUB_CREDITS_PER_MONTH = { starter: 60, professional: 150, studio: 200 };
const FUNDS_CENTS_PER_CREDIT = 15; // $0.15/credit (100-pack rate)

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

function sbAdmin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const sig = event.headers['stripe-signature'];
  if (sig) return handleWebhook(event, sig);
  return handleCreateIntent(event);
};

// ── A: CLIENT → CREATE PAYMENT INTENT ────────────────────────────────────────

async function handleCreateIntent(event) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Server not configured' });
  }

  const auth = (event.headers.authorization || event.headers.Authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  const sb = sbAdmin();
  const { data: userData, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const giver = userData.user;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { gift_type, recipient_email, credits_amount, plan_tier, duration_months, amount_usd, message, ecard_cover_id } = body;

  if (!gift_type || !recipient_email) return json(400, { error: 'Missing gift_type or recipient_email' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient_email)) return json(400, { error: 'Invalid recipient email' });

  let amountCents, description, metadata;

  if (gift_type === 'credits') {
    const credits = parseInt(credits_amount);
    if (!CREDIT_PACK_PRICES[credits]) return json(400, { error: `Invalid credit amount. Valid: ${Object.keys(CREDIT_PACK_PRICES).join(', ')}` });
    amountCents = CREDIT_PACK_PRICES[credits];
    description = `${credits} Greylander Press credits → ${recipient_email}`;
    metadata = {
      gift_type: 'credits',
      giver_id: giver.id,
      giver_email: giver.email,
      recipient_email,
      credits_amount: String(credits),
      message: (message || '').slice(0, 500),
      ecard_cover_id: ecard_cover_id || 'classic',
    };

  } else if (gift_type === 'subscription') {
    if (!SUB_MONTHLY_PRICES[plan_tier]) return json(400, { error: 'Invalid plan tier' });
    const dur = parseInt(duration_months) || 1;
    if (![1, 3, 12].includes(dur)) return json(400, { error: 'Invalid duration. Use 1, 3, or 12.' });
    const monthlyRate = SUB_MONTHLY_PRICES[plan_tier];
    const annualDiscount = dur === 12 ? 0.833 : 1.0;
    amountCents = Math.round(monthlyRate * dur * annualDiscount);
    const totalCredits = SUB_CREDITS_PER_MONTH[plan_tier] * dur;
    description = `GP ${plan_tier} subscription gift (${dur} month${dur > 1 ? 's' : ''}, ${totalCredits} credits) → ${recipient_email}`;
    metadata = {
      gift_type: 'subscription',
      giver_id: giver.id,
      giver_email: giver.email,
      recipient_email,
      plan_tier,
      duration_months: String(dur),
      credits_amount: String(totalCredits),
      message: (message || '').slice(0, 500),
      ecard_cover_id: ecard_cover_id || 'classic',
    };

  } else if (gift_type === 'funds') {
    const usd = parseFloat(amount_usd);
    if (!usd || usd < 5 || usd > 500) return json(400, { error: 'Amount must be $5–$500' });
    amountCents = Math.round(usd * 100);
    const credits = Math.floor(amountCents / FUNDS_CENTS_PER_CREDIT);
    description = `$${usd} GP writing funds (${credits} credits) → ${recipient_email}`;
    metadata = {
      gift_type: 'funds',
      giver_id: giver.id,
      giver_email: giver.email,
      recipient_email,
      amount_usd: String(usd),
      credits_amount: String(credits),
      message: (message || '').slice(0, 500),
      ecard_cover_id: ecard_cover_id || 'classic',
    };

  } else {
    return json(400, { error: 'Unknown gift_type' });
  }

  // ── Owner bypass — no charge for the site owner ──────────────────────────
  const OWNER_EMAIL = 'starbucks005@gmail.com';
  if (giver.email.toLowerCase() === OWNER_EMAIL) {
    const creditsToGrant = parseInt(metadata.credits_amount) || 0;
    const recipientEmail = recipient_email.toLowerCase().trim();

    let recipientId = null;
    try {
      let page = 1;
      outer: while (true) {
        const { data: { users }, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
        if (error || !users?.length) break;
        for (const u of users) {
          if (u.email?.toLowerCase() === recipientEmail) { recipientId = u.id; break outer; }
        }
        if (users.length < 1000) break;
        page++;
      }
    } catch {}

    const bypassId = `owner_bypass_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const { data: ownerTxn, error: ownerTxnErr } = await sb.from('gift_transactions').insert({
      giver_id: giver.id,
      recipient_email: recipientEmail,
      gift_type,
      credits_amount: creditsToGrant,
      plan_tier: metadata.plan_tier || null,
      duration_months: metadata.duration_months ? parseInt(metadata.duration_months) : null,
      amount_usd: 0,
      price_paid_cents: 0,
      ecard_cover_id: ecard_cover_id || 'classic',
      message: (message || '').slice(0, 500),
      stripe_payment_intent: bypassId,
      status: recipientId ? 'credited' : 'pending',
    }).select('id').single();
    if (ownerTxnErr) {
      console.error('[gift] owner-bypass gift_transactions insert failed:', ownerTxnErr.message);
      return json(500, { error: 'Could not record gift' });
    }

    if (recipientId && creditsToGrant > 0) {
      // Recipient has an account — credit immediately
      const { data: balRow } = await sb.from('gp_credits').select('balance').eq('user_id', recipientId).single();
      if (balRow) {
        await sb.from('gp_credits').update({ balance: (balRow.balance || 0) + creditsToGrant }).eq('user_id', recipientId);
      } else {
        await sb.from('gp_credits').insert({ user_id: recipientId, balance: creditsToGrant });
      }
    } else if (!recipientId && creditsToGrant > 0) {
      // No account yet — queue for claim-on-signup (mirrors the Stripe-paid path)
      await sb.from('pending_credit_balances').insert({
        recipient_email: recipientEmail,
        credit_amount: creditsToGrant,
        gift_transaction_id: ownerTxn.id,
        status: 'pending',
      });
    }

    return json(200, {
      owner_bypass: true,
      gift_id: ownerTxn.id,
      credits_amount: creditsToGrant,
      recipient_has_account: !!recipientId,
      status: recipientId ? 'credited' : 'pending',
    });
  }

  // ── Stripe PaymentIntent ───────────────────────────────────────────────────
  try {
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      description,
      receipt_email: giver.email,
      metadata,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });
    return json(200, { client_secret: intent.client_secret, payment_intent_id: intent.id });
  } catch (err) {
    console.error('[gift] Stripe PaymentIntent create failed:', err.message);
    return json(500, { error: 'Payment setup failed. Please try again.' });
  }
}

// ── B: STRIPE WEBHOOK → APPLY CREDITS ────────────────────────────────────────

async function handleWebhook(event, sig) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json(500, { error: 'Webhook secret not configured' });

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('[gift-webhook] Signature verification failed:', err.message);
    return json(400, { error: `Webhook signature failed: ${err.message}` });
  }

  // Only process successful payments
  if (stripeEvent.type !== 'payment_intent.succeeded') {
    return json(200, { received: true, type: stripeEvent.type });
  }

  const intent = stripeEvent.data.object;
  const meta = intent.metadata || {};

  if (!meta.gift_type || !meta.recipient_email) {
    // Not a gift PaymentIntent — ignore silently
    return json(200, { received: true });
  }

  const sb = sbAdmin();
  const creditsToGrant = parseInt(meta.credits_amount) || 0;
  const recipientEmail = meta.recipient_email.toLowerCase().trim();

  // Find recipient user_id by email (admin API)
  let recipientId = null;
  try {
    let page = 1;
    outer: while (true) {
      const { data: { users }, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
      if (error || !users?.length) break;
      for (const u of users) {
        if (u.email?.toLowerCase() === recipientEmail) { recipientId = u.id; break outer; }
      }
      if (users.length < 1000) break;
      page++;
    }
  } catch (err) {
    console.error('[gift-webhook] listUsers failed:', err.message);
  }

  const txnStatus = recipientId ? 'credited' : 'pending';

  // Write gift_transactions row
  const { data: txn, error: txnErr } = await sb.from('gift_transactions').insert({
    giver_id: meta.giver_id || null,
    recipient_email: recipientEmail,
    gift_type: meta.gift_type,
    credits_amount: creditsToGrant,
    plan_tier: meta.plan_tier || null,
    duration_months: meta.duration_months ? parseInt(meta.duration_months) : null,
    amount_usd: meta.amount_usd ? parseFloat(meta.amount_usd) : (intent.amount / 100),
    price_paid_cents: intent.amount,
    ecard_cover_id: meta.ecard_cover_id || 'classic',
    message: meta.message || '',
    stripe_payment_intent: intent.id,
    status: txnStatus,
  }).select('id').single();

  if (txnErr) {
    console.error('[gift-webhook] gift_transactions insert failed:', txnErr);
    return json(500, { error: 'DB write failed' });
  }

  if (recipientId && creditsToGrant > 0) {
    // Recipient has an account — credit immediately using same select+update pattern
    const { data: balRow } = await sb.from('gp_credits').select('balance').eq('user_id', recipientId).single();
    if (balRow) {
      await sb.from('gp_credits').update({ balance: (balRow.balance || 0) + creditsToGrant }).eq('user_id', recipientId);
    } else {
      await sb.from('gp_credits').insert({ user_id: recipientId, balance: creditsToGrant });
    }
  } else if (!recipientId && creditsToGrant > 0) {
    // No account yet — store as pending for when they sign up
    await sb.from('pending_credit_balances').insert({
      recipient_email: recipientEmail,
      credit_amount: creditsToGrant,
      gift_transaction_id: txn.id,
      status: 'pending',
    });
  }

  console.log(`[gift-webhook] ${meta.gift_type} gift: ${creditsToGrant} credits → ${recipientEmail} (status: ${txnStatus})`);
  return json(200, { received: true });
}
