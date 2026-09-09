// supabase/functions/paddle-webhook/index.ts
// Paddle Billing webhook that keeps the `subscriptions` table in sync.
//
// Handled events:
//   - subscription.created
//   - subscription.updated
//
// Deploy with:
//   supabase functions deploy paddle-webhook
//
// The Supabase runtime automatically injects SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY. For production, also set the PADDLE_WEBHOOK_SECRET
// secret so the Paddle-Secret-Key header is verified before processing.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. These are injected automatically by the Supabase Edge runtime.'
  );
}

// Service-role client: bypasses RLS so webhooks can upsert subscriptions.
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface PaddleSubscriptionEventData {
  id?: string;
  customer_id?: string;
  status?: string;
  custom_data?: { user_id?: string };
  items?: Array<{ price?: { id?: string } }>;
  /** Paddle classic webhooks provide an epoch-seconds timestamp. */
  current_period_end?: string | number;
  /** Paddle Billing (v2) exposes the billing window instead. */
  current_billing_period?: { ends_at?: string };
}

interface PaddleWebhookEvent {
  event_type?: string;
  data?: PaddleSubscriptionEventData;
}

/** Normalise a Paddle date into a Postgres timestamptz-compatible string. */
function toIsoDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    // Treat bare numbers as epoch seconds (Paddle classic convention).
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const jsonHeaders = { 'Content-Type': 'application/json' };

serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: jsonHeaders,
      });
    }

    // Optional signature check. Recommended in production: set the
    // PADDLE_WEBHOOK_SECRET secret to the secret configured on the webhook.
    const secret = Deno.env.get('PADDLE_WEBHOOK_SECRET');
    if (secret) {
      const provided = req.headers.get('Paddle-Secret-Key');
      if (provided !== secret) {
        return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
          status: 401,
          headers: jsonHeaders,
        });
      }
    }

    let event: PaddleWebhookEvent;
    try {
      event = (await req.json()) as PaddleWebhookEvent;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const eventType = event.event_type;
    const data = event.data ?? {};

    // Acknowledge every delivery, but only react to lifecycle events we own.
    if (eventType !== 'subscription.created' && eventType !== 'subscription.updated') {
      return new Response(
        JSON.stringify({ ok: true, event_type: eventType, handled: false }),
        { status: 200, headers: jsonHeaders }
      );
    }

    // The checkout payload (customData) carries the logged-in user id.
    const userId = data.custom_data?.user_id;
    const subscriptionId = data.id;
    if (!userId || !subscriptionId) {
      return new Response(
        JSON.stringify({ error: 'Missing custom_data.user_id or data.id' }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const { error } = await supabaseAdmin.from('subscriptions').upsert(
      {
        user_id: userId,
        paddle_customer_id: data.customer_id ?? null,
        paddle_subscription_id: subscriptionId,
        status: data.status ?? null,
        price_id: data.items?.[0]?.price?.id ?? null,
        current_period_end: toIsoDate(
          data.current_period_end ?? data.current_billing_period?.ends_at ?? null
        ),
        updated_at: new Date().toISOString(),
      },
      // The subscriptions table keeps one row per user, so conflict on
      // user_id and let the latest Paddle event overwrite the row.
      { onConflict: 'user_id' }
    );

    if (error) {
      console.error('Failed to upsert subscription:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: jsonHeaders,
      });
    }

    return new Response(
      JSON.stringify({ ok: true, event_type: eventType, handled: true }),
      { status: 200, headers: jsonHeaders }
    );
  } catch (err) {
    console.error('Unhandled webhook error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
