import type { APIRoute } from 'astro';
import { verifyTurnstile } from '../../../lib/turnstile';

// Ensure this route is not prerendered (server-side only)
export const prerender = false;

const WP_API_URL = import.meta.env.WC_API_URL || '';
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET || '';
const WC_ACCESS_SECRET = import.meta.env.WC_ACCESS_SECRET || '';

export const POST: APIRoute = async ({ request }) => {
    try {
        const { email, password, turnstile_token } = await request.json();
        
        if (!email || !password) {
            return new Response(
                JSON.stringify({ success: false, error: 'Email and password are required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('cf-connecting-ip') || '';
        const turnstileResult = await verifyTurnstile(turnstile_token, ip);
        if (!turnstileResult.success) {
            return new Response(
                JSON.stringify({ success: false, error: turnstileResult.error }),
                { status: 403, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        if (!WP_API_URL) {
            return new Response(
                JSON.stringify({ success: false, error: 'WooCommerce not configured' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        // Call WordPress JWT authentication endpoint
        const loginHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (WC_ACCESS_SECRET) loginHeaders['X-PhantomWP-Secret'] = WC_ACCESS_SECRET;
        const response = await fetch(`${WP_API_URL}/jwt-auth/v1/token`, {
            method: 'POST',
            headers: loginHeaders,
            body: JSON.stringify({ username: email, password }),
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            return new Response(
                JSON.stringify({ 
                    success: false, 
                    error: data.message || 'Authentication failed' 
                }),
                { status: response.status, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        // Optionally fetch customer ID if WooCommerce is present
        let customerId: number | undefined;
        try {
            if (WC_CONSUMER_KEY && WC_CONSUMER_SECRET) {
                const customerUrl = new URL(`${WP_API_URL}/wc/v3/customers`);
                customerUrl.searchParams.set('email', email);
                
                const customerResponse = await fetch(customerUrl.toString(), {
                    headers: {
                        'Authorization': `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`,
                    },
                });
                
                if (customerResponse.ok) {
                    const customers = await customerResponse.json();
                    if (customers.length > 0) {
                        customerId = customers[0].id;
                    }
                }
            }
        } catch {
            // Customer lookup is optional
        }
        
        return new Response(
            JSON.stringify({
                success: true,
                token: data.token,
                user_email: data.user_email,
                user_nicename: data.user_nicename,
                user_display_name: data.user_display_name,
                customer_id: customerId,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Login error:', error);
        return new Response(
            JSON.stringify({ 
                success: false, 
                error: error instanceof Error ? error.message : 'Server error' 
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
