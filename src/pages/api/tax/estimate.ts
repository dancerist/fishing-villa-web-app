/**
 * Tax Estimate API Route
 * 
 * POST /api/tax/estimate
 * Returns estimated tax based on customer location and cart items
 */

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

export const POST: APIRoute = async ({ request }) => {
    try {
        const { country, state, postcode, line_items } = await request.json();

        if (!country || !Array.isArray(line_items) || line_items.length === 0) {
            return new Response(
                JSON.stringify({ success: false, error: 'Country and line_items required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const taxRes = await wcGet(`taxes?country=${encodeURIComponent(country)}${state ? `&state=${encodeURIComponent(state)}` : ''}${postcode ? `&postcode=${encodeURIComponent(postcode)}` : ''}&per_page=100`);

        if (!taxRes.ok) {
            return new Response(
                JSON.stringify({ success: false, error: 'Failed to fetch tax rates' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const taxRates = await taxRes.json();

        if (!Array.isArray(taxRates) || taxRates.length === 0) {
            return new Response(
                JSON.stringify({ success: true, tax_total: 0, tax_rate: 0, rates: [] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const combinedRate = taxRates.reduce((sum: number, rate: any) => {
            return sum + (parseFloat(rate.rate) || 0);
        }, 0);

        const subtotal = line_items.reduce((sum: number, item: any) => {
            return sum + (parseFloat(item.price) || 0) * (item.quantity || 1);
        }, 0);

        const taxTotal = Math.round(subtotal * (combinedRate / 100) * 100) / 100;

        return new Response(
            JSON.stringify({
                success: true,
                tax_total: taxTotal,
                tax_rate: Math.round(combinedRate * 100) / 100,
                rates: taxRates.map((r: any) => ({
                    name: r.name,
                    rate: r.rate,
                    compound: r.compound,
                })),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Tax estimate error:', error);
        return new Response(
            JSON.stringify({ success: false, error: 'Server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
