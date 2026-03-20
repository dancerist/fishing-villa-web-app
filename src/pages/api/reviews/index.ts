import type { APIRoute } from 'astro';

export const prerender = false;

const WC_API_URL = import.meta.env.WC_API_URL;
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET;
const WC_ACCESS_SECRET = import.meta.env.WC_ACCESS_SECRET;

async function wcGet(endpoint: string) {
    const url = new URL(`${WC_API_URL}/wc/v3/${endpoint}`);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`,
    };
    if (WC_ACCESS_SECRET) {
        headers['X-PhantomWP-Secret'] = WC_ACCESS_SECRET;
    }
    return fetch(url.toString(), { headers });
}

export const GET: APIRoute = async ({ request }) => {
    const url = new URL(request.url);
    const productId = url.searchParams.get('product_id');

    if (!productId) {
        return new Response(
            JSON.stringify({ success: false, error: 'product_id is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    try {
        const res = await wcGet(`products/reviews?product=${productId}&per_page=50&orderby=date_created&order=desc`);
        if (!res.ok) {
            return new Response(
                JSON.stringify({ success: false, error: 'Failed to fetch reviews' }),
                { status: res.status, headers: { 'Content-Type': 'application/json' } }
            );
        }
        const reviews = await res.json();
        return new Response(
            JSON.stringify({
                success: true,
                reviews: reviews.map((r: any) => ({
                    id: r.id,
                    reviewer: r.reviewer,
                    rating: r.rating,
                    review: r.review,
                    date_created: r.date_created,
                    verified: r.verified,
                })),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Get reviews error:', error);
        return new Response(
            JSON.stringify({ success: false, error: 'Server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
