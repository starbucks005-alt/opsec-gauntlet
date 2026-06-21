/* opsec-access-verify — confirm Stripe subscription access.
   GET ?session_id=xxx        → verify just-completed checkout session
   GET ?subscription_id=xxx   → re-check existing subscription status */

const Stripe = require('stripe');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(code, body) {
  return { statusCode: code, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const key = process.env.STRIPE_SECRET_API_KEY;
  if (!key) return json(503, { error: 'not_configured' });

  const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  const params = event.queryStringParameters || {};

  if (params.session_id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(params.session_id);
      if (session.status !== 'complete') return json(200, { ok: false, reason: 'incomplete' });
      return json(200, { ok: true, customer_id: session.customer, subscription_id: session.subscription });
    } catch(err) {
      return json(200, { ok: false, reason: 'stripe_error' });
    }
  }

  if (params.subscription_id) {
    try {
      const sub = await stripe.subscriptions.retrieve(params.subscription_id);
      const active = sub.status === 'active' || sub.status === 'trialing';
      return json(200, { ok: active, status: sub.status });
    } catch(err) {
      return json(200, { ok: false, reason: 'stripe_error' });
    }
  }

  return json(400, { error: 'missing param: session_id or subscription_id' });
};
