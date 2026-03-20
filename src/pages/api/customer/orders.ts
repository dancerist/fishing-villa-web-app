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

export const GET: APIRoute = async ({ request }) => {
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
                JSON.stringify({ success: true, orders: [] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        // Fetch orders for this customer
        const url = new URL(`${WP_API_URL}/wc/v3/orders`);
        url.searchParams.set('customer', customer.id.toString());
        url.searchParams.set('per_page', '10');
        url.searchParams.set('orderby', 'date');
        url.searchParams.set('order', 'desc');
        
        const response = await fetch(url.toString(), {
            headers: getWcHeaders(),
        });

        if (!response.ok) {
            return new Response(
                JSON.stringify({ success: true, orders: [] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        const rawOrders = await response.json();
        
        // Only return fields the frontend needs (strip PII, IPs, metadata)
        const orders = rawOrders.map((o: any) => ({
            id: o.id,
            number: o.number,
            status: o.status,
            date_created: o.date_created,
            total: o.total,
            currency: o.currency,
            currency_symbol: o.currency_symbol,
            line_items: (o.line_items || []).map((li: any) => ({
                id: li.id,
                name: li.name,
                quantity: li.quantity,
                price: li.price,
                subtotal: li.subtotal,
                total: li.total,
                image: li.image,
            })),
            shipping_total: o.shipping_total,
            payment_method: o.payment_method,
            payment_method_title: o.payment_method_title,
        }));
        
        return new Response(
            JSON.stringify({ success: true, orders }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Get orders error:', error);
        return new Response(
            JSON.stringify({ success: false, error: 'Server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
