/**
 * PayPal Payment API Routes
 * 
 * Handles PayPal order creation and capture
 */

import type { APIRoute } from 'astro';

const PAYPAL_CLIENT_ID = import.meta.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = import.meta.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE = import.meta.env.PAYPAL_MODE || 'sandbox';
const PAYPAL_API_URL = PAYPAL_MODE === 'live' 
    ? 'https://api-m.paypal.com' 
    : 'https://api-m.sandbox.paypal.com';
const SITE_URL = import.meta.env.PUBLIC_SITE_URL || 'http://localhost:4321';

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

/**
 * Get PayPal access token
 */
async function getPayPalAccessToken(): Promise<string> {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(`${PAYPAL_API_URL}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
    });
    
    if (!response.ok) {
        throw new Error('Failed to get PayPal access token');
    }
    
    const data = await response.json();
    return data.access_token;
}

/**
 * POST /api/payments/paypal/create-session
 * Creates a PayPal order for checkout
 */
export const POST: APIRoute = async ({ request }) => {
    try {
        const { order_id, order_key } = await request.json();
        
        if (!order_id) {
            return new Response(
                JSON.stringify({ success: false, error: 'Order ID required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        // Fetch order details from WooCommerce
        const orderResponse = await wcRequest(`orders/${order_id}`);
        if (!orderResponse.ok) {
            return new Response(
                JSON.stringify({ success: false, error: 'Order not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        const order = await orderResponse.json();
        
        // Verify order key
        if (order.order_key !== order_key) {
            return new Response(
                JSON.stringify({ success: false, error: 'Invalid order key' }),
                { status: 403, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        const accessToken = await getPayPalAccessToken();
        
        // Create PayPal order
        const paypalResponse = await fetch(`${PAYPAL_API_URL}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    reference_id: order.id.toString(),
                    description: `Order #${order.number}`,
                    amount: {
                        currency_code: order.currency,
                        value: order.total,
                    },
                }],
                application_context: {
                    brand_name: 'Store',
                    landing_page: 'NO_PREFERENCE',
                    user_action: 'PAY_NOW',
                    return_url: `${SITE_URL}/api/payments/paypal/capture?wc_order_id=${order.id}&wc_order_key=${encodeURIComponent(order.order_key)}`,
                    cancel_url: `${SITE_URL}/checkout?cancelled=true&order_id=${order.id}`,
                },
            }),
        });
        
        if (!paypalResponse.ok) {
            const error = await paypalResponse.text();
            console.error('PayPal order creation failed:', error);
            return new Response(
                JSON.stringify({ success: false, error: 'Failed to create PayPal order' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        const paypalOrder = await paypalResponse.json();
        
        // Find the approval URL
        const approvalLink = paypalOrder.links?.find((link: any) => link.rel === 'approve');
        
        return new Response(
            JSON.stringify({
                success: true,
                paypal_order_id: paypalOrder.id,
                redirect_url: approvalLink?.href,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('PayPal session creation error:', error);
        return new Response(
            JSON.stringify({ 
                success: false, 
                error: error instanceof Error ? error.message : 'Payment error' 
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
