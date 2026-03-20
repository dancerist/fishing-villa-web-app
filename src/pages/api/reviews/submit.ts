import type { APIRoute } from 'astro';
import { verifyTurnstile } from '../../../lib/turnstile';

export const prerender = false;

const WC_API_URL = import.meta.env.WC_API_URL;
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET;
const WC_ACCESS_SECRET = import.meta.env.WC_ACCESS_SECRET;

export const POST: APIRoute = async ({ request }) => {
    try {
        const { product_id, rating, review, reviewer, reviewer_email, turnstile_token } = await request.json();

        const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('cf-connecting-ip') || '';
        const turnstileResult = await verifyTurnstile(turnstile_token, ip);
        if (!turnstileResult.success) {
            return new Response(
                JSON.stringify({ success: false, error: turnstileResult.error }),
                { status: 403, headers: { 'Content-Type': 'application/json' } }
            );
        }

        if (!product_id || !rating || !review) {
            return new Response(
                JSON.stringify({ success: false, error: 'product_id, rating, and review are required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        if (rating < 1 || rating > 5) {
            return new Response(
                JSON.stringify({ success: false, error: 'Rating must be between 1 and 5' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const url = new URL(`${WC_API_URL}/wc/v3/products/reviews`);
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`,
        };
        if (WC_ACCESS_SECRET) {
            headers['X-PhantomWP-Secret'] = WC_ACCESS_SECRET;
        }

        const res = await fetch(url.toString(), {
            method: 'POST',
            headers,
            body: JSON.stringify({
                product_id: Number(product_id),
                review,
                reviewer: reviewer || 'Anonymous',
                reviewer_email: reviewer_email || '',
                rating: Number(rating),
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return new Response(
                JSON.stringify({ success: false, error: err.message || 'Failed to submit review' }),
                { status: res.status, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const created = await res.json();
        return new Response(
            JSON.stringify({
                success: true,
                review: {
                    id: created.id,
                    reviewer: created.reviewer,
                    rating: created.rating,
                    review: created.review,
                    date_created: created.date_created,
                    verified: created.verified,
                },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Submit review error:', error);
        return new Response(
            JSON.stringify({ success: false, error: 'Server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
