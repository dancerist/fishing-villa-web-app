/**
 * Get Order API Route
 *
 * GET /api/orders/[orderId]?order_key=wc_order_xxx
 * Returns a scoped-down view of an order for the confirmation page.
 * Requires a valid order_key to prevent order enumeration.
 */

import type { APIRoute } from 'astro';

export const prerender = false;

const WC_API_URL = import.meta.env.WC_API_URL || '';
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET || '';

async function wcGet(endpoint: string) {
    const url = new URL(`${WC_API_URL}/wc/v3/${endpoint}`);
    return fetch(url.toString(), {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`,
        },
    });
}

export const GET: APIRoute = async ({ params, request }) => {
    const orderId = params.orderId;

    if (!orderId || !/^\d+$/.test(orderId)) {
        return new Response(
            JSON.stringify({ success: false, error: 'Invalid order ID' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    if (!WC_API_URL || !WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) {
        return new Response(
            JSON.stringify({ success: false, error: 'WooCommerce not configured' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // Require order_key to prevent order enumeration
    const url = new URL(request.url);
    const orderKey = url.searchParams.get('order_key');

    if (!orderKey) {
        return new Response(
            JSON.stringify({ success: false, error: 'Order key is required' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
    }

    try {
        const res = await wcGet(`orders/${orderId}`);

        if (!res.ok) {
            return new Response(
                JSON.stringify({ success: false, error: 'Order not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const order = await res.json();

        // Verify the order_key matches
        if (order.order_key !== orderKey) {
            return new Response(
                JSON.stringify({ success: false, error: 'Invalid order key' }),
                { status: 403, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Return only the fields the frontend needs
        return new Response(
            JSON.stringify({
                success: true,
                id: order.id,
                number: order.number,
                status: order.status,
                date_created: order.date_created,
                total: order.total,
                currency: order.currency,
                currency_symbol: order.currency_symbol,
                payment_method_title: order.payment_method_title,
                billing: {
                    email: order.billing?.email,
                    first_name: order.billing?.first_name,
                    last_name: order.billing?.last_name,
                },
                shipping_total: order.shipping_total,
                line_items: (order.line_items || []).map((li: any) => ({
                    id: li.id,
                    name: li.name,
                    quantity: li.quantity,
                    price: li.price,
                    total: li.total,
                    image: li.image,
                })),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Get order error:', error);
        return new Response(
            JSON.stringify({ success: false, error: 'Failed to fetch order' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
