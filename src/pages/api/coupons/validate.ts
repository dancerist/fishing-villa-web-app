/**
 * Coupon Validation API Route
 * 
 * POST /api/coupons/validate
 * Validates a coupon code against WooCommerce and calculates the discount preview
 */

import type { APIRoute } from 'astro';

export const prerender = false;

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
        const body = await request.json();
        const { code, line_items } = body;

        if (!code || typeof code !== 'string') {
            return new Response(
                JSON.stringify({ success: false, error: 'Coupon code is required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const trimmedCode = code.trim().toLowerCase();

        const couponRes = await wcRequest(`coupons?code=${encodeURIComponent(trimmedCode)}`);
        if (!couponRes.ok) {
            return new Response(
                JSON.stringify({ success: false, error: 'Failed to validate coupon' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const coupons = await couponRes.json();
        if (!Array.isArray(coupons) || coupons.length === 0) {
            return new Response(
                JSON.stringify({ success: false, error: 'Invalid coupon code' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const coupon = coupons[0];

        // Check expiry
        if (coupon.date_expires) {
            const expiryDate = new Date(coupon.date_expires);
            if (expiryDate < new Date()) {
                return new Response(
                    JSON.stringify({ success: false, error: 'This coupon has expired' }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }
        }

        // Check usage limit
        if (coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit) {
            return new Response(
                JSON.stringify({ success: false, error: 'This coupon has reached its usage limit' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Calculate cart subtotal from line items for minimum/maximum check
        let cartSubtotal = 0;
        if (Array.isArray(line_items)) {
            cartSubtotal = line_items.reduce((sum: number, item: any) => {
                return sum + (parseFloat(item.price) || 0) * (item.quantity || 1);
            }, 0);
        }

        // Check minimum amount
        if (coupon.minimum_amount && parseFloat(coupon.minimum_amount) > 0) {
            if (cartSubtotal < parseFloat(coupon.minimum_amount)) {
                return new Response(
                    JSON.stringify({
                        success: false,
                        error: `Minimum spend of ${parseFloat(coupon.minimum_amount).toFixed(2)} required`,
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }
        }

        // Check maximum amount
        if (coupon.maximum_amount && parseFloat(coupon.maximum_amount) > 0) {
            if (cartSubtotal > parseFloat(coupon.maximum_amount)) {
                return new Response(
                    JSON.stringify({
                        success: false,
                        error: `Maximum spend of ${parseFloat(coupon.maximum_amount).toFixed(2)} exceeded`,
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }
        }

        // Calculate preview discount
        const amount = parseFloat(coupon.amount) || 0;
        let discountAmount = 0;

        switch (coupon.discount_type) {
            case 'percent':
                discountAmount = cartSubtotal * (amount / 100);
                break;
            case 'fixed_cart':
                discountAmount = Math.min(amount, cartSubtotal);
                break;
            case 'fixed_product': {
                if (Array.isArray(line_items)) {
                    const applicableItems = line_items.filter((item: any) => {
                        if (coupon.product_ids?.length > 0 && !coupon.product_ids.includes(item.product_id)) {
                            return false;
                        }
                        if (coupon.excluded_product_ids?.length > 0 && coupon.excluded_product_ids.includes(item.product_id)) {
                            return false;
                        }
                        return true;
                    });
                    let itemCount = applicableItems.reduce((sum: number, item: any) => sum + (item.quantity || 1), 0);
                    if (coupon.limit_usage_to_x_items && coupon.limit_usage_to_x_items > 0) {
                        itemCount = Math.min(itemCount, coupon.limit_usage_to_x_items);
                    }
                    discountAmount = amount * itemCount;
                } else {
                    discountAmount = amount;
                }
                discountAmount = Math.min(discountAmount, cartSubtotal);
                break;
            }
            default:
                discountAmount = 0;
        }

        discountAmount = Math.round(discountAmount * 100) / 100;

        let description = '';
        if (coupon.discount_type === 'percent') {
            description = `${amount}% off`;
        } else {
            description = 'fixed_amount';
        }

        return new Response(
            JSON.stringify({
                success: true,
                code: coupon.code,
                discount_type: coupon.discount_type,
                discount_amount: discountAmount,
                description,
                free_shipping: coupon.free_shipping || false,
                individual_use: coupon.individual_use || false,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Coupon validation error:', error);
        return new Response(
            JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Server error',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
