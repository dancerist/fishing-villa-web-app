/**
 * Stripe Webhook Handler
 * 
 * POST /api/payments/stripe/webhook
 * Receives Stripe webhook events and updates WooCommerce orders
 */

import type { APIRoute } from 'astro';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = import.meta.env.STRIPE_WEBHOOK_SECRET;

// WooCommerce API configuration
const WC_API_URL = import.meta.env.WC_API_URL;
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET;
const WC_ACCESS_SECRET = import.meta.env.WC_ACCESS_SECRET;

async function wcRequest(endpoint: string, options: RequestInit = {}) {
    const url = new URL(`${WC_API_URL}/wc/v3/${endpoint}`);

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`,
        ...(options.headers as Record<string, string> || {}),
    };
    
    if (WC_ACCESS_SECRET) {
        headers['X-PhantomWP-Secret'] = WC_ACCESS_SECRET;
    }
    
    return fetch(url.toString(), {
        ...options,
        headers,
    });
}

export const POST: APIRoute = async ({ request }) => {
    const signature = request.headers.get('stripe-signature');
    
    if (!signature) {
        return new Response(
            JSON.stringify({ error: 'Missing signature' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }
    
    try {
        const body = await request.text();
        
        // Verify webhook signature
        let event: Stripe.Event;
        try {
            event = stripe.webhooks.constructEvent(body, signature, WEBHOOK_SECRET);
        } catch (err) {
            console.error('Webhook signature verification failed:', err);
            return new Response(
                JSON.stringify({ error: 'Invalid signature' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        /**
         * Helper: mark a WC order as paid, with idempotency check
         */
        async function markOrderPaid(orderId: string, transactionId: string | null) {
            // Fetch order first to check current status (idempotency)
            const orderRes = await wcRequest(`orders/${orderId}`);
            if (!orderRes.ok) {
                console.error(`Could not fetch order ${orderId} for status check`);
                return;
            }
            const order = await orderRes.json();
            const skipStatuses = ['processing', 'completed', 'refunded'];
            if (skipStatuses.includes(order.status)) {
                console.log(`Order ${orderId} already ${order.status}, skipping update`);
                return;
            }

            await wcRequest(`orders/${orderId}`, {
                method: 'PUT',
                body: JSON.stringify({
                    status: 'processing',
                    transaction_id: transactionId || '',
                    set_paid: true,
                }),
            });
            console.log(`Order ${orderId} marked as paid via Stripe`);
        }

        // Handle the event
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object as Stripe.Checkout.Session;
                const orderId = session.metadata?.wc_order_id;
                
                if (orderId && session.payment_status === 'paid') {
                    await markOrderPaid(orderId, session.payment_intent as string);
                }
                break;
            }
            
            case 'payment_intent.succeeded': {
                const paymentIntent = event.data.object as Stripe.PaymentIntent;
                const orderId = paymentIntent.metadata?.wc_order_id;
                if (orderId) {
                    await markOrderPaid(orderId, paymentIntent.id);
                }
                break;
            }
            
            case 'payment_intent.payment_failed': {
                const paymentIntent = event.data.object as Stripe.PaymentIntent;
                const orderId = paymentIntent.metadata?.wc_order_id;
                console.error(`Payment failed: ${paymentIntent.id}${orderId ? ` (order ${orderId})` : ''}`);
                
                if (orderId) {
                    await wcRequest(`orders/${orderId}`, {
                        method: 'PUT',
                        body: JSON.stringify({
                            status: 'failed',
                        }),
                    });
                }
                break;
            }
            
            case 'charge.refunded': {
                const charge = event.data.object as Stripe.Charge;
                const paymentIntentId = typeof charge.payment_intent === 'string' 
                    ? charge.payment_intent 
                    : charge.payment_intent?.id;
                console.log(`Charge refunded: ${charge.id} (payment_intent: ${paymentIntentId})`);
                break;
            }
            
            default:
                console.log(`Unhandled event type: ${event.type}`);
        }
        
        return new Response(
            JSON.stringify({ received: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Webhook error:', error);
        return new Response(
            JSON.stringify({ error: 'Webhook handler failed' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
