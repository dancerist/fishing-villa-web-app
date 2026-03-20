import type { APIRoute } from 'astro';

export const prerender = false;

const WP_API_URL = import.meta.env.WC_API_URL || '';
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET || '';
const WC_ACCESS_SECRET = import.meta.env.WC_ACCESS_SECRET || '';

export const POST: APIRoute = async ({ request }) => {
    try {
        const authHeader = request.headers.get('Authorization');
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return new Response(
                JSON.stringify({ valid: false, error: 'No token provided' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        if (!WP_API_URL) {
            return new Response(
                JSON.stringify({ valid: false, error: 'WooCommerce not configured' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        const token = authHeader.substring(7);
        
        // Call WordPress JWT validation endpoint
        const valHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        };
        if (WC_ACCESS_SECRET) valHeaders['X-PhantomWP-Secret'] = WC_ACCESS_SECRET;
        const response = await fetch(`${WP_API_URL}/jwt-auth/v1/token/validate`, {
            method: 'POST',
            headers: valHeaders,
        });
        
        if (!response.ok) {
            return new Response(
                JSON.stringify({ valid: false, error: 'Invalid token' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        return new Response(
            JSON.stringify({ valid: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Validation error:', error);
        return new Response(
            JSON.stringify({ valid: false, error: 'Validation failed' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
