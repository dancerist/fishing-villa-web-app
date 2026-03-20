/**
 * PayPal Capture Handler
 * 
 * GET /api/payments/paypal/capture
 * Called by PayPal after user approves payment
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

export const GET: APIRoute = async ({ request }) => {
    const url = new URL(request.url);
    const token = url.searchParams.get('token'); // PayPal order ID
    const wcOrderId = url.searchParams.get('wc_order_id');
    const wcOrderKey = url.searchParams.get('wc_order_key') || '';
    
    if (!token || !wcOrderId) {
        return Response.redirect(`${SITE_URL}/checkout?error=missing_params`, 302);
    }
    
    try {
        const accessToken = await getPayPalAccessToken();
        
        // Capture the PayPal order
        const captureResponse = await fetch(`${PAYPAL_API_URL}/v2/checkout/orders/${token}/capture`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });
        
        if (!captureResponse.ok) {
            console.error('PayPal capture failed:', await captureResponse.text());
            return Response.redirect(`${SITE_URL}/checkout?error=capture_failed&order_id=${wcOrderId}`, 302);
        }
        
        const captureData = await captureResponse.json();
        
        if (captureData.status === 'COMPLETED') {
            const captureId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.id;
            
            // Update WooCommerce order to processing
            const updateRes = await wcRequest(`orders/${wcOrderId}`, {
                method: 'PUT',
                body: JSON.stringify({
                    status: 'processing',
                    transaction_id: captureId || token,
                    set_paid: true,
                }),
            });
            
            console.log(`Order ${wcOrderId} marked as paid via PayPal`);
            
            // Use order_key from URL params, fall back to fetching from response
            let orderKey = wcOrderKey;
            if (!orderKey && updateRes.ok) {
                const updatedOrder = await updateRes.json();
                orderKey = updatedOrder.order_key || '';
            }
            
            return Response.redirect(`${SITE_URL}/order-complete?order_id=${wcOrderId}&order_key=${encodeURIComponent(orderKey)}`, 302);
        }
        
        // Payment not completed
        return Response.redirect(`${SITE_URL}/checkout?error=payment_incomplete&order_id=${wcOrderId}`, 302);
    } catch (error) {
        console.error('PayPal capture error:', error);
        return Response.redirect(`${SITE_URL}/checkout?error=capture_error&order_id=${wcOrderId}`, 302);
    }
};
