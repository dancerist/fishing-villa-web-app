/**
 * Stripe PaymentIntent Creation
 *
 * POST /api/payments/stripe/create-intent
 * Creates a PaymentIntent for the inline Stripe Payment Element.
 * Returns the client_secret so the browser can confirm the payment
 * without ever sending card data to our server.
 */

import type { APIRoute } from 'astro';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY);

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
    try {
        const { order_id, order_key } = await request.json();

        if (!order_id) {
            return new Response(
                JSON.stringify({ success: false, error: 'Order ID required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const orderResponse = await wcRequest(`orders/${order_id}`);
        if (!orderResponse.ok) {
            return new Response(
                JSON.stringify({ success: false, error: 'Order not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const order = await orderResponse.json();

        if (order.order_key !== order_key) {
            return new Response(
                JSON.stringify({ success: false, error: 'Invalid order key' }),
                { status: 403, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const amount = Math.round(parseFloat(order.total) * 100);
        const currency = order.currency.toLowerCase();

        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency,
            metadata: {
                wc_order_id: order.id.toString(),
                wc_order_key: order.order_key,
            },
            receipt_email: order.billing.email || undefined,
            payment_method_types: ['card'],
        });

        return new Response(
            JSON.stringify({
                success: true,
                client_secret: paymentIntent.client_secret,
                amount,
                currency,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Stripe PaymentIntent creation error:', error);
        return new Response(
            JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Payment error',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
