/**
 * Create Order API Route
 * 
 * POST /api/orders/create
 * Creates a WooCommerce order and returns redirect URL for payment
 */

import type { APIRoute } from 'astro';
import { verifyTurnstile } from '../../../lib/turnstile';

export const prerender = false;

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
 * Validate a JWT with WordPress and extract the user email
 */
async function validateTokenAndGetEmail(token: string): Promise<{ valid: boolean; email?: string; userId?: number }> {
    try {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        };
        if (WC_ACCESS_SECRET) {
            headers['X-PhantomWP-Secret'] = WC_ACCESS_SECRET;
        }

        const validateRes = await fetch(`${WC_API_URL}/jwt-auth/v1/token/validate`, {
            method: 'POST',
            headers,
        });
        if (!validateRes.ok) return { valid: false };

        const payload = JSON.parse(atob(token.split('.')[1]));
        const email = payload.data?.user?.email || payload.email || null;
        const userId = payload.data?.user?.id || payload.sub || null;
        return { valid: true, email: email || undefined, userId: userId ? Number(userId) : undefined };
    } catch {
        return { valid: false };
    }
}

export const POST: APIRoute = async ({ request }) => {
    try {
        const body = await request.json();
        const { billing, shipping, line_items, shipping_lines, coupon_lines, customer_note, payment_gateway, turnstile_token } = body;
        
        // Validate JWT early so authenticated users can skip Turnstile
        const authHeader = request.headers.get('Authorization');
        let authTokenInfo: { valid: boolean; email?: string; userId?: number } = { valid: false };
        if (authHeader?.startsWith('Bearer ')) {
            authTokenInfo = await validateTokenAndGetEmail(authHeader.substring(7));
        }
        const isAuthenticated = authTokenInfo.valid;

        if (!isAuthenticated) {
            const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('cf-connecting-ip') || '';
            const turnstileResult = await verifyTurnstile(turnstile_token, ip);
            if (!turnstileResult.success) {
                return new Response(
                    JSON.stringify({ success: false, error: turnstileResult.error }),
                    { status: 403, headers: { 'Content-Type': 'application/json' } }
                );
            }
        }
        
        // Validate required fields
        if (!billing || !line_items || !payment_gateway) {
            return new Response(
                JSON.stringify({ 
                    success: false, 
                    error: 'Missing required fields: billing, line_items, or payment_gateway' 
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        // Validate line items
        if (!Array.isArray(line_items) || line_items.length === 0) {
            return new Response(
                JSON.stringify({ 
                    success: false, 
                    error: 'Cart is empty' 
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        // Build order data for WooCommerce
        const paymentTitle = body.payment_gateway_title || payment_gateway;
        const isManualPayment = ['bacs', 'cheque', 'cod'].includes(payment_gateway);
        const orderData: Record<string, any> = {
            payment_method: payment_gateway,
            payment_method_title: paymentTitle,
            set_paid: false,
            status: isManualPayment ? 'on-hold' : 'pending',
            billing: {
                first_name: billing.first_name || '',
                last_name: billing.last_name || '',
                company: billing.company || '',
                address_1: billing.address_1 || '',
                address_2: billing.address_2 || '',
                city: billing.city || '',
                state: billing.state || '',
                postcode: billing.postcode || '',
                country: billing.country || 'US',
                email: billing.email || '',
                phone: billing.phone || '',
            },
            line_items: line_items.map((item: any) => ({
                product_id: item.product_id,
                quantity: item.quantity,
                ...(item.variation_id && { variation_id: item.variation_id }),
            })),
        };
        
        // Add shipping address if provided (otherwise use billing)
        if (shipping) {
            orderData.shipping = {
                first_name: shipping.first_name || billing.first_name || '',
                last_name: shipping.last_name || billing.last_name || '',
                company: shipping.company || billing.company || '',
                address_1: shipping.address_1 || billing.address_1 || '',
                address_2: shipping.address_2 || billing.address_2 || '',
                city: shipping.city || billing.city || '',
                state: shipping.state || billing.state || '',
                postcode: shipping.postcode || billing.postcode || '',
                country: shipping.country || billing.country || 'US',
            };
        }
        
        // Associate a customer_id with the order
        let customerId: number | null = null;
        
        // Use JWT token to get the WP user ID directly
        if (authTokenInfo.valid && authTokenInfo.userId) {
            try {
                const directRes = await wcRequest(`customers/${authTokenInfo.userId}`);
                if (directRes.ok) {
                    const customer = await directRes.json();
                    if (customer && customer.id) {
                        customerId = customer.id;
                    }
                }
            } catch {
                // Direct lookup failed
            }
        }
        
        // Method 2: Fall back to billing email lookup
        if (!customerId && billing.email) {
            try {
                const custRes = await wcRequest(`customers?email=${encodeURIComponent(billing.email)}`);
                if (custRes.ok) {
                    const customers = await custRes.json();
                    if (customers.length > 0) {
                        customerId = customers[0].id;
                    }
                }
            } catch {
                // Email lookup failed - create as guest order
            }
        }
        
        if (customerId) {
            orderData.customer_id = customerId;
        }
        
        // Add customer note if provided
        if (customer_note) {
            orderData.customer_note = customer_note;
        }
        
        // Add shipping lines if provided
        if (shipping_lines && Array.isArray(shipping_lines) && shipping_lines.length > 0) {
            orderData.shipping_lines = shipping_lines.map((sl: any) => ({
                method_id: sl.method_id || 'flat_rate',
                method_title: sl.method_title || 'Shipping',
                total: sl.total || '0.00',
            }));
        }
        
        // Add coupon lines if provided (WooCommerce validates and calculates discounts server-side)
        if (coupon_lines && Array.isArray(coupon_lines) && coupon_lines.length > 0) {
            orderData.coupon_lines = coupon_lines
                .filter((cl: any) => cl.code && typeof cl.code === 'string')
                .map((cl: any) => ({ code: cl.code.trim().toLowerCase() }));
        }
        
        // Create order in WooCommerce
        const wcResponse = await wcRequest('orders', {
            method: 'POST',
            body: JSON.stringify(orderData),
        });
        
        if (!wcResponse.ok) {
            const error = await wcResponse.json();
            console.error('WooCommerce order creation failed:', error);
            return new Response(
                JSON.stringify({ 
                    success: false, 
                    error: error.message || 'Failed to create order' 
                }),
                { status: wcResponse.status, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        const order = await wcResponse.json();
        
        return new Response(
            JSON.stringify({
                success: true,
                order_id: order.id,
                order_key: order.order_key,
                total: order.total,
                discount_total: order.discount_total || '0.00',
                total_tax: order.total_tax || '0.00',
                cart_tax: order.cart_tax || '0.00',
                shipping_tax: order.shipping_tax || '0.00',
                currency: order.currency,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Order creation error:', error);
        return new Response(
            JSON.stringify({ 
                success: false, 
                error: error instanceof Error ? error.message : 'Server error' 
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
