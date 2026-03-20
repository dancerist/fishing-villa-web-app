/**
 * Stripe Payment API Routes
 * 
 * Handles Stripe Checkout Session creation and webhook processing
 */

import type { APIRoute } from 'astro';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = import.meta.env.STRIPE_WEBHOOK_SECRET;
const SITE_URL = import.meta.env.PUBLIC_SITE_URL || 'http://localhost:4321';

// WooCommerce API configuration
const WC_API_URL = import.meta.env.WC_API_URL;
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET;
const WC_ACCESS_SECRET = import.meta.env.WC_ACCESS_SECRET;

/**
 * Helper to make authenticated WooCommerce API requests
 */
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
 * POST /api/payments/stripe/create-session
 * Creates a Stripe Checkout Session for an order
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
        
        // Build line items for Stripe from WooCommerce order
        const lineItems = order.line_items.map((item: any) => ({
            price_data: {
                currency: order.currency.toLowerCase(),
                product_data: {
                    name: item.name,
                },
                unit_amount: Math.round(parseFloat(item.price) * 100),
            },
            quantity: item.quantity,
        }));
        
        // Add shipping if present
        if (parseFloat(order.shipping_total) > 0) {
            lineItems.push({
                price_data: {
                    currency: order.currency.toLowerCase(),
                    product_data: {
                        name: 'Shipping',
                    },
                    unit_amount: Math.round(parseFloat(order.shipping_total) * 100),
                },
                quantity: 1,
            });
        }
        
        // Add tax if present
        const totalTax = parseFloat(order.total_tax) || 0;
        if (totalTax > 0) {
            lineItems.push({
                price_data: {
                    currency: order.currency.toLowerCase(),
                    product_data: {
                        name: 'Tax',
                    },
                    unit_amount: Math.round(totalTax * 100),
                },
                quantity: 1,
            });
        }
        
        // Handle coupon discounts via Stripe's discount system
        const discountTotal = parseFloat(order.discount_total) || 0;
        let sessionDiscounts: Array<{ coupon: string }> | undefined;
        if (discountTotal > 0) {
            const stripeCoupon = await stripe.coupons.create({
                amount_off: Math.round(discountTotal * 100),
                currency: order.currency.toLowerCase(),
                duration: 'once',
                name: order.coupon_lines?.map((c: any) => c.code.toUpperCase()).join(', ') || 'Discount',
            });
            sessionDiscounts = [{ coupon: stripeCoupon.id }];
        }
        
        // Create Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: lineItems,
            ...(sessionDiscounts ? { discounts: sessionDiscounts } : {}),
            customer_email: order.billing.email,
            metadata: {
                wc_order_id: order.id.toString(),
                wc_order_key: order.order_key,
            },
            success_url: `${SITE_URL}/order-complete?order_id=${order.id}&order_key=${encodeURIComponent(order.order_key)}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${SITE_URL}/checkout?cancelled=true&order_id=${order.id}`,
        });
        
        return new Response(
            JSON.stringify({
                success: true,
                session_id: session.id,
                redirect_url: session.url,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Stripe session creation error:', error);
        return new Response(
            JSON.stringify({ 
                success: false, 
                error: error instanceof Error ? error.message : 'Payment error' 
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
