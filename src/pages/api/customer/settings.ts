import type { APIRoute } from 'astro';

export const prerender = false;

const WP_API_URL = import.meta.env.WC_API_URL || '';
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET || '';
const WC_ACCESS_SECRET = import.meta.env.WC_ACCESS_SECRET || '';

async function validateToken(token: string): Promise<boolean> {
    if (!WP_API_URL) return false;
    try {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        };
        if (WC_ACCESS_SECRET) headers['X-PhantomWP-Secret'] = WC_ACCESS_SECRET;
        const response = await fetch(`${WP_API_URL}/jwt-auth/v1/token/validate`, {
            method: 'POST',
            headers,
        });
        return response.ok;
    } catch {
        return false;
    }
}

function getWcHeaders(): Record<string, string> {
    const h: Record<string, string> = {
        'Authorization': `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`,
    };
    if (WC_ACCESS_SECRET) h['X-PhantomWP-Secret'] = WC_ACCESS_SECRET;
    return h;
}

function getBasicAuth(): string {
    return `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`;
}

async function getCustomerByEmail(email: string): Promise<any | null> {
    if (!WP_API_URL || !WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) return null;
    try {
        const url = new URL(`${WP_API_URL}/wc/v3/customers`);
        url.searchParams.set('email', email);

        const response = await fetch(url.toString(), {
            headers: getWcHeaders(),
        });
        if (!response.ok) return null;
        
        const customers = await response.json();
        return customers.length > 0 ? customers[0] : null;
    } catch {
        return null;
    }
}

function getTokenFromRequest(request: Request): string | null {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    return authHeader.substring(7);
}

/**
 * Extract user email or ID from a JWT token.
 * The WP JWT Auth plugin only stores { data: { user: { id } } } in the payload,
 * so we also check for user ID and look up the email via WC REST API if needed.
 */
function getEmailFromToken(token: string): string | null {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.data?.user?.email || payload.email || null;
    } catch {
        return null;
    }
}

function getUserIdFromToken(token: string): number | null {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const id = payload.data?.user?.id || payload.sub || payload.user_id || null;
        return id ? Number(id) : null;
    } catch {
        return null;
    }
}

/**
 * Resolve the authenticated customer from a JWT token.
 * Tries email first, falls back to WP user ID lookup.
 */
async function getAuthenticatedCustomer(token: string): Promise<any | null> {
    const email = getEmailFromToken(token);
    if (email) {
        return getCustomerByEmail(email);
    }

    const userId = getUserIdFromToken(token);
    if (!userId || !WP_API_URL || !WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) return null;

    try {
        // First try direct customer fetch (WC customer ID often matches WP user ID)
        const directUrl = new URL(`${WP_API_URL}/wc/v3/customers/${userId}`);

        const directRes = await fetch(directUrl.toString(), {
            headers: getWcHeaders(),
        });
        if (directRes.ok) {
            const customer = await directRes.json();
            if (customer && customer.id) return customer;
        }
    } catch {
        // Fall through
    }

    return null;
}

export const PUT: APIRoute = async ({ request }) => {
    try {
        const token = getTokenFromRequest(request);

        if (!token) {
            return new Response(
                JSON.stringify({ success: false, error: 'Not authenticated' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const isValid = await validateToken(token);
        if (!isValid) {
            return new Response(
                JSON.stringify({ success: false, error: 'Invalid token' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const customer = await getAuthenticatedCustomer(token);
        if (!customer) {
            return new Response(
                JSON.stringify({ success: false, error: 'Customer not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const body = await request.json();
        const updateData: Record<string, any> = {};

        if (body.first_name !== undefined) updateData.first_name = body.first_name;
        if (body.last_name !== undefined) updateData.last_name = body.last_name;
        if (body.password) {
            if (body.password.length < 8) {
                return new Response(
                    JSON.stringify({ success: false, error: 'Password must be at least 8 characters' }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }
            updateData.password = body.password;
        }

        if (Object.keys(updateData).length === 0) {
            return new Response(
                JSON.stringify({ success: false, error: 'No fields to update' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const url = new URL(`${WP_API_URL}/wc/v3/customers/${customer.id}`);

        const response = await fetch(url.toString(), {
            method: 'PUT',
            headers: {
                ...getWcHeaders(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(updateData),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            return new Response(
                JSON.stringify({ success: false, error: err.message || 'Failed to update settings' }),
                { status: response.status, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const updated = await response.json();

        return new Response(
            JSON.stringify({
                success: true,
                customer: {
                    id: updated.id,
                    email: updated.email,
                    first_name: updated.first_name,
                    last_name: updated.last_name,
                },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Update settings error:', error);
        return new Response(
            JSON.stringify({ success: false, error: 'Server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
