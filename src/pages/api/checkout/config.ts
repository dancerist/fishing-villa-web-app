/**
 * Checkout Config API Route
 * 
 * GET /api/checkout/config
 * Returns enabled payment gateways, shipping zones/methods,
 * and the customer's saved addresses if authenticated.
 */

import type { APIRoute } from 'astro';

export const prerender = false;

const WC_API_URL = import.meta.env.WC_API_URL || '';
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET || '';
const WC_ACCESS_SECRET = import.meta.env.WC_ACCESS_SECRET || '';
const BACS_ENABLED = import.meta.env.PUBLIC_PAYMENT_BACS_ENABLED === 'true';

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

export const GET: APIRoute = async ({ request }) => {
    if (!WC_API_URL || !WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) {
        return new Response(
            JSON.stringify({ success: false, error: 'WooCommerce not configured' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    try {
        // Fetch payment gateways, shipping zones, and store settings in parallel
        const [gatewaysRes, zonesRes, settingsRes, taxSettingsRes, accountSettingsRes] = await Promise.all([
            wcGet('payment_gateways'),
            wcGet('shipping/zones'),
            wcGet('settings/general'),
            wcGet('settings/tax'),
            wcGet('settings/account'),
        ]);

        // --- Payment Gateways ---
        let paymentGateways: any[] = [];
        if (gatewaysRes.ok) {
            const allGateways = await gatewaysRes.json();
            const hiddenGateways = ['stripe_link'];
            const paypalIds = ['ppcp-gateway', 'ppcp-card-button-gateway', 'paypal_express'];

            function normalizeGatewayId(id: string): string {
                if (id === 'stripe_cc') return 'stripe';
                if (paypalIds.includes(id)) return 'paypal';
                return id;
            }

            const seen = new Set<string>();
            paymentGateways = allGateways
                .filter((g: any) => g.enabled && !hiddenGateways.includes(g.id))
                .map((g: any) => ({
                    id: normalizeGatewayId(g.id),
                    title: g.title || g.method_title,
                    description: g.description || g.method_description || '',
                    order: g.order ?? 0,
                }))
                .filter((g: any) => {
                    if (seen.has(g.id)) return false;
                    seen.add(g.id);
                    return true;
                })
                .sort((a: any, b: any) => a.order - b.order);
        }

        // Inject BACS if enabled in env but not already present from WooCommerce
        if (BACS_ENABLED && !paymentGateways.some((g: any) => g.id === 'bacs')) {
            paymentGateways.push({
                id: 'bacs',
                title: 'Direct Bank Transfer',
                description: 'Make your payment directly into our bank account. Your order will be processed once the payment is confirmed.',
                order: 99,
            });
        }

        // --- Shipping Zones & Methods ---
        let shippingZones: any[] = [];
        if (zonesRes.ok) {
            const zones = await zonesRes.json();
            // Fetch methods for each zone in parallel
            const zoneDetails = await Promise.all(
                zones.map(async (zone: any) => {
                    const methodsRes = await wcGet(`shipping/zones/${zone.id}/methods`);
                    let methods: any[] = [];
                    if (methodsRes.ok) {
                        const allMethods = await methodsRes.json();
                        methods = allMethods
                            .filter((m: any) => m.enabled)
                            .map((m: any) => {
                                // Extract cost from settings - WooCommerce stores it in settings.cost.value
                                // For flat_rate, also check settings.cost.value directly
                                // For free_shipping, cost is always 0
                                let cost: string | null = null;
                                if (m.method_id === 'free_shipping') {
                                    cost = '0';
                                } else if (m.settings?.cost?.value !== undefined && m.settings?.cost?.value !== '') {
                                    cost = m.settings.cost.value;
                                }

                                return {
                                    id: m.id,
                                    instance_id: m.instance_id,
                                    method_id: m.method_id,
                                    title: m.title,
                                    cost,
                                    min_amount: m.settings?.min_amount?.value ?? null,
                                    requires: m.settings?.requires?.value ?? null,
                                };
                            });
                    }

                    // Fetch zone locations
                    const locsRes = await wcGet(`shipping/zones/${zone.id}/locations`);
                    let locations: any[] = [];
                    if (locsRes.ok) {
                        locations = await locsRes.json();
                    }

                    return {
                        id: zone.id,
                        name: zone.name,
                        order: zone.order,
                        locations,
                        methods,
                    };
                })
            );
            shippingZones = zoneDetails.filter((z: any) => z.methods.length > 0);
        }

        // --- Currency from settings ---
        let currency = 'USD';
        let currencySymbol = '$';
        if (settingsRes.ok) {
            const settings = await settingsRes.json();
            const currSetting = settings.find((s: any) => s.id === 'woocommerce_currency');
            if (currSetting) currency = currSetting.value;
            // WooCommerce doesn't return the symbol directly from settings/general,
            // but we can derive common ones or the checkout can use formatPrice.
        }

        // --- Tax settings ---
        let taxEnabled = false;
        let taxDisplay = 'excl';
        if (taxSettingsRes.ok) {
            const taxSettings = await taxSettingsRes.json();
            const enabledSetting = taxSettings.find((s: any) => s.id === 'woocommerce_calc_taxes');
            const displaySetting = taxSettings.find((s: any) => s.id === 'woocommerce_tax_display_cart');
            if (enabledSetting) taxEnabled = enabledSetting.value === 'yes';
            if (displaySetting) taxDisplay = displaySetting.value || 'excl';
        }

        // --- Guest checkout ---
        let guestCheckoutEnabled = true;
        if (accountSettingsRes.ok) {
            const accountSettings = await accountSettingsRes.json();
            const guestSetting = accountSettings.find((s: any) => s.id === 'woocommerce_enable_guest_checkout');
            if (guestSetting) guestCheckoutEnabled = guestSetting.value === 'yes';
        }

        // --- Customer addresses (if logged in) ---
        let customerAddresses: any = null;
        const authHeader = request.headers.get('Authorization');
        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.substring(7);

            // Validate the JWT with WordPress before trusting its claims
            let tokenValid = false;
            try {
                const validateHeaders: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                };
                if (WC_ACCESS_SECRET) {
                    validateHeaders['X-PhantomWP-Secret'] = WC_ACCESS_SECRET;
                }
                const validateRes = await fetch(`${WC_API_URL}/jwt-auth/v1/token/validate`, {
                    method: 'POST',
                    headers: validateHeaders,
                });
                tokenValid = validateRes.ok;
            } catch {
                tokenValid = false;
            }

            if (!tokenValid) {
                // Token invalid - skip customer lookup but still return config
            }

            const email = tokenValid ? getEmailFromToken(token) : null;
            const userId = tokenValid ? getUserIdFromToken(token) : null;

            try {
                let customer: any = null;

                const basicAuth = `Basic ${btoa(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`)}`;

                if (email) {
                    const custUrl = new URL(`${WC_API_URL}/wc/v3/customers`);
                    custUrl.searchParams.set('email', email);
                    const custRes = await fetch(custUrl.toString(), {
                        headers: { 'Authorization': basicAuth },
                    });
                    if (custRes.ok) {
                        const customers = await custRes.json();
                        if (customers.length > 0) customer = customers[0];
                    }
                }

                if (!customer && userId) {
                    const directUrl = new URL(`${WC_API_URL}/wc/v3/customers/${userId}`);
                    const directRes = await fetch(directUrl.toString(), {
                        headers: { 'Authorization': basicAuth },
                    });
                    if (directRes.ok) {
                        const c = await directRes.json();
                        if (c && c.id) customer = c;
                    }
                }

                if (customer) {
                    customerAddresses = {
                        billing: customer.billing,
                        shipping: customer.shipping,
                        email: customer.email,
                        first_name: customer.first_name,
                        last_name: customer.last_name,
                    };
                }
            } catch {
                // Customer lookup is optional
            }
        }

        return new Response(
            JSON.stringify({
                success: true,
                payment_gateways: paymentGateways,
                shipping_zones: shippingZones,
                currency,
                tax_enabled: taxEnabled,
                tax_display: taxDisplay,
                guest_checkout_enabled: guestCheckoutEnabled,
                customer: customerAddresses,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Checkout config error:', error);
        return new Response(
            JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to load checkout config',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
