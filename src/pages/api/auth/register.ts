import type { APIRoute } from 'astro';
import { verifyTurnstile } from '../../../lib/turnstile';

export const prerender = false;

const WP_API_URL = import.meta.env.WC_API_URL || '';
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET || '';
const WC_ACCESS_SECRET = import.meta.env.WC_ACCESS_SECRET || '';

export const POST: APIRoute = async ({ request }) => {
    try {
        const { email, password, firstName, lastName, turnstile_token } = await request.json();
        
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
        
        if (!WP_API_URL || !WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) {
            return new Response(
                JSON.stringify({ success: false, error: 'WooCommerce not configured' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        // Create WooCommerce customer (which also creates WP user)
        const customerUrl = new URL(`${WP_API_URL}/wc/v3/customers`);
        
        // Derive a clean username from email (strip special chars, add random suffix for uniqueness)
        const emailPrefix = email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase();
        const randomBytes = new Uint8Array(3);
        crypto.getRandomValues(randomBytes);
        const username = emailPrefix + '_' + Array.from(randomBytes).map(b => b.toString(36)).join('').substring(0, 4);
        
        const customerData = {
            email,
            password,
            first_name: firstName || '',
            last_name: lastName || '',
            username,
        };
        
        const response = await fetch(customerUrl.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`,
            },
            body: JSON.stringify(customerData),
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            let errorMessage = data.message || 'Registration failed';
            
            if (data.code === 'registration-error-email-exists') {
                errorMessage = 'An account with this email already exists';
            } else if (data.code === 'registration-error-username-exists') {
                errorMessage = 'An account with this username already exists';
            }
            
            return new Response(
                JSON.stringify({ success: false, error: errorMessage }),
                { status: response.status, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        return new Response(
            JSON.stringify({
                success: true,
                customer_id: data.id,
                email: data.email,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Registration error:', error);
        return new Response(
            JSON.stringify({ 
                success: false, 
                error: error instanceof Error ? error.message : 'Server error' 
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
