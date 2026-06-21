/* opsec-checkout — create a Stripe Checkout subscription session.
   POST {} → { url } redirect to Stripe, or { bypass: true } for dev. */

const Stripe = require('stripe');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(code, body) {
  return { statusCode: code, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_) {}

  // Dev bypass
  const devKey    = (body.dev_key || '').trim();
  const envDevKey = (process.env.BYOA_DEV_KEY || '').trim();
  if (devKey && envDevKey && devKey === envDevKey) {
    return json(200, { ok: true, bypass: true });
  }

  const key = process.env.STRIPE_SECRET_API_KEY;
  if (!key) return json(503, { error: 'payment_not_configured' });

  const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host  = event.headers['host'] || 'opsec-gauntlet.netlify.app';
  const base  = proto + '://' + host;

  const rawPath = (body.return_path || '/intake.html').replace(/[^a-zA-Z0-9/._-]/g, '');
  const returnPath = rawPath.startsWith('/') ? rawPath : '/intake.html';

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          recurring: { interval: 'month' },
          product_data: { name: 'OPSEC Gauntlet — Monthly Access' },
          unit_amount: 1999,
        },
        quantity: 1,
      }],
      success_url: base + returnPath + '?subscribed=1&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  base + returnPath,
    });
  } catch(err) {
    console.error('opsec-checkout stripe error:', err.message);
    return json(502, { error: 'stripe_error', detail: err.message });
  }

  return json(200, { url: session.url });
};
