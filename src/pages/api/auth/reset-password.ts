import type { APIRoute } from 'astro';

export const prerender = false;

const WC_API_URL = import.meta.env.WC_API_URL || '';
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET || '';
const JWT_SECRET = import.meta.env.JWT_SECRET || '';

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
        if (payload.purpose !== 'password_reset') return null;

        return payload;
    } catch {
        return null;
    }
}

export const POST: APIRoute = async ({ request }) => {
    try {
        const { token, password } = await request.json();

        if (!token || !password) {
            return new Response(
                JSON.stringify({ success: false, error: 'Token and password are required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        if (password.length < 8) {
            return new Response(
                JSON.stringify({ success: false, error: 'Password must be at least 8 characters' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        if (!WC_API_URL || !WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) {
            return new Response(
                JSON.stringify({ success: false, error: 'Store not configured' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }

        if (!JWT_SECRET || JWT_SECRET.length < 16) {
            return new Response(
                JSON.stringify({ success: false, error: 'Password reset is not available' }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Verify the reset token
        const payload = await verifyToken(token, JWT_SECRET);

        if (!payload || !payload.sub) {
            return new Response(
                JSON.stringify({ success: false, error: 'Invalid or expired reset link. Please request a new one.' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const basicAuth = `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`;

        // Verify the nonce hasn't changed (token was not already used)
        if (payload.nonce !== undefined) {
            try {
                const custCheckUrl = new URL(`${WC_API_URL}/wc/v3/customers/${payload.sub}`);
                const custCheckRes = await fetch(custCheckUrl.toString(), {
                    headers: { 'Authorization': basicAuth },
                });
                if (custCheckRes.ok) {
                    const custData = await custCheckRes.json();
                    const currentNonce = custData.meta_data?.find((m: any) => m.key === '_phantomwp_pw_reset_count')?.value || '0';
                    if (currentNonce !== payload.nonce) {
                        return new Response(
                            JSON.stringify({ success: false, error: 'This reset link has already been used. Please request a new one.' }),
                            { status: 400, headers: { 'Content-Type': 'application/json' } }
                        );
                    }
                }
            } catch {
                // If we can't verify the nonce, proceed with the reset (fail-open for usability)
            }
        }

        // Update the customer's password via WooCommerce REST API
        const updateUrl = new URL(`${WC_API_URL}/wc/v3/customers/${payload.sub}`);

        const updateRes = await fetch(updateUrl.toString(), {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': basicAuth,
            },
            body: JSON.stringify({ password }),
        });

        if (!updateRes.ok) {
            const err = await updateRes.json().catch(() => ({}));
            return new Response(
                JSON.stringify({ success: false, error: err.message || 'Failed to update password' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Clear the reset token meta and increment reset count to invalidate old tokens
        try {
            await fetch(updateUrl.toString(), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': basicAuth,
                },
                body: JSON.stringify({
                    meta_data: [
                        { key: '_phantomwp_reset_token_exp', value: '' },
                        { key: '_phantomwp_pw_reset_count', value: String(Date.now()) },
                    ]
                }),
            });
        } catch {
            // Non-critical
        }

        return new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Reset password error:', error);
        return new Response(
            JSON.stringify({ success: false, error: 'An error occurred' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
