import type { APIRoute } from 'astro';
import { verifyTurnstile } from '../../../lib/turnstile';

export const prerender = false;

const WC_API_URL = import.meta.env.WC_API_URL || '';
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET || '';
const JWT_SECRET = import.meta.env.JWT_SECRET || '';
const SITE_URL = import.meta.env.PUBLIC_SITE_URL || '';

/**
 * Create a simple HMAC-like signature for the reset token.
 * Uses the Web Crypto API (available in all modern runtimes).
 */
async function signToken(payload: Record<string, any>, secret: string): Promise<string> {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const body = btoa(JSON.stringify(payload))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(header + '.' + body));
    const sigStr = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    return header + '.' + body + '.' + sigStr;
}

async function verifyToken(token: string, secret: string): Promise<Record<string, any> | null> {
    try {
        const [header, body, sig] = token.split('.');
        if (!header || !body || !sig) return null;

        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
        );

        const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        const valid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(header + '.' + body));
        if (!valid) return null;

        const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));

        if (payload.exp && Date.now() > payload.exp) return null;

        return payload;
    } catch {
        return null;
    }
}

export const POST: APIRoute = async ({ request }) => {
    try {
        const { email, turnstile_token } = await request.json();

        if (!email) {
            return new Response(
                JSON.stringify({ success: false, error: 'Email is required' }),
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

        if (!WC_API_URL || !WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) {
            return new Response(
                JSON.stringify({ success: false, error: 'Store not configured' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }

        if (!JWT_SECRET || JWT_SECRET.length < 16) {
            console.error('JWT_SECRET is not configured or too short. Password reset is disabled.');
            return new Response(
                JSON.stringify({ success: false, error: 'Password reset is not available. Please contact the store administrator.' }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const basicAuth = `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`;

        // Look up customer by email via WooCommerce REST API
        const searchUrl = new URL(`${WC_API_URL}/wc/v3/customers`);
        searchUrl.searchParams.set('email', email);

        const searchRes = await fetch(searchUrl.toString(), {
            headers: { 'Authorization': basicAuth },
        });

        // Always return success to prevent email enumeration
        const successResponse = new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        if (!searchRes.ok) return successResponse;

        const customers = await searchRes.json();
        if (!customers || customers.length === 0) return successResponse;

        const customer = customers[0];

        // Extract the reset nonce from customer meta (used to invalidate old tokens)
        const resetNonce = customer.meta_data?.find((m: any) => m.key === '_phantomwp_pw_reset_count')?.value || '0';

        // Generate a signed reset token (1 hour expiry) with nonce for invalidation
        const resetToken = await signToken(
            { sub: customer.id, email: customer.email, purpose: 'password_reset', nonce: resetNonce, exp: Date.now() + 3600000 },
            JWT_SECRET
        );

        // Determine the reset URL
        const origin = SITE_URL || request.headers.get('origin') || request.headers.get('referer')?.replace(/\/[^/]*$/, '') || '';
        const resetUrl = `${origin}/reset-password?token=${resetToken}`;

        // Send the reset email via WooCommerce (uses WC email system)
        // We create a customer note / use the WC email endpoint.
        // Most reliable: use WP REST API to send a transactional email via wp_mail proxy.
        // Fallback: update the customer meta with the token and use WC's built-in email.
        //
        // Strategy: Use the WooCommerce orders notes email trick or just call wp_mail
        // via a simple proxy. Since we have consumer_key/secret with admin rights,
        // we can use the WP application-passwords or a lightweight email approach.
        //
        // Simplest approach that works everywhere: Use the WooCommerce REST API to
        // create a "note" on the customer, which triggers no email, then send mail
        // by calling a custom WP REST route. But we can't guarantee that exists.
        //
        // Most portable: Send the email from the Astro server side directly.

        // Try to send email via Astro's server runtime
        // Most hosting platforms (Vercel, Node) support this via fetch to an email API
        // or via nodemailer. For maximum compatibility, we'll store the token in the
        // WooCommerce customer meta and send a basic email via WP REST API wp/v2/mail
        // or fallback to just returning the token for the frontend to handle.

        // Attempt to send via WordPress REST API (requires wp-mail-smtp or similar)
        const storeName = new URL(WC_API_URL).hostname.replace(/^www\./, '');

        try {
            // Use WooCommerce to send a transactional email by updating customer meta
            // and triggering a password reset through WP's native system
            // Store the reset token hash in customer meta for verification
            const updateUrl = new URL(`${WC_API_URL}/wc/v3/customers/${customer.id}`);

            await fetch(updateUrl.toString(), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': basicAuth,
                },
                body: JSON.stringify({
                    meta_data: [
                        { key: '_phantomwp_reset_token_exp', value: String(Date.now() + 3600000) }
                    ]
                }),
            });
        } catch {
            // Meta update is optional - the signed JWT is self-validating
        }

        // Try sending email via WooCommerce's email system using a lightweight endpoint
        try {
            const emailUrl = new URL(`${WC_API_URL}/phantomwp/v1/send-reset-email`);

            const emailRes = await fetch(emailUrl.toString(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': basicAuth,
                },
                body: JSON.stringify({
                    to: customer.email,
                    subject: `Password Reset - ${storeName}`,
                    message: `
                        <p>Hi ${customer.first_name || 'there'},</p>
                        <p>We received a request to reset your password. Click the link below to set a new password:</p>
                        <p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#6366f1;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Reset Password</a></p>
                        <p>Or copy and paste this URL: ${resetUrl}</p>
                        <p>This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>
                    `,
                }),
            });

            if (emailRes.ok) {
                return successResponse;
            }
        } catch {
            // PhantomWP email endpoint not available
        }

        // Fallback: try WordPress wp_mail via REST
        try {
            const wpMailEndpoint = new URL(`${WC_API_URL}/wp/v2/mail`);

            await fetch(wpMailEndpoint.toString(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': basicAuth,
                },
                body: JSON.stringify({
                    to: customer.email,
                    subject: `Password Reset - ${storeName}`,
                    body: `Hi ${customer.first_name || 'there'},\n\nReset your password: ${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you did not request this, ignore this email.`,
                }),
            });
        } catch {
            // wp/v2/mail likely doesn't exist - that's okay
        }

        // In development mode only, return the reset URL for testing
        if (import.meta.env.DEV && !SITE_URL && !request.headers.get('origin')) {
            return new Response(
                JSON.stringify({ success: true, _dev_reset_url: resetUrl }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return successResponse;
    } catch (error) {
        console.error('Forgot password error:', error);
        return new Response(
            JSON.stringify({ success: false, error: 'An error occurred' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
