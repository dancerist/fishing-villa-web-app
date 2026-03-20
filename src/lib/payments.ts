/**
 * Payment Gateway Abstraction
 * 
 * Unified interface for Stripe and PayPal payment processing
 * Store owner enables gateways via environment variables
 * 
 * Environment Variables:
 *   PUBLIC_PAYMENT_STRIPE_ENABLED=true  (PUBLIC_ prefix for client-side access)
 *   PUBLIC_PAYMENT_PAYPAL_ENABLED=true  (PUBLIC_ prefix for client-side access)
 *   STRIPE_SECRET_KEY=sk_xxx
 *   PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_xxx
 *   PAYPAL_CLIENT_ID=xxx
 *   PAYPAL_CLIENT_SECRET=xxx
 *   PAYPAL_MODE=sandbox|live
 */

// ============================================================================
// Types
// ============================================================================

export type PaymentGatewayId = 'stripe' | 'paypal' | 'bacs';

export interface PaymentGateway {
    id: PaymentGatewayId;
    name: string;
    icon: string;
    enabled: boolean;
}

export interface CreatePaymentSessionRequest {
    order_id: number;
    order_key: string;
    total: string;
    currency: string;
    billing: {
        email: string;
        first_name: string;
        last_name: string;
    };
    line_items: Array<{
        name: string;
        quantity: number;
        price: number;
    }>;
    success_url: string;
    cancel_url: string;
}

export interface PaymentSessionResponse {
    success: boolean;
    redirect_url?: string;
    session_id?: string;
    error?: string;
}

// ============================================================================
// Gateway Configuration
// ============================================================================

/**
 * Check if Stripe is enabled
 * Note: Uses PUBLIC_ prefix so it's available on client-side
 */
export function isStripeEnabled(): boolean {
    if (typeof import.meta.env === 'undefined') return false;
    return import.meta.env.PUBLIC_PAYMENT_STRIPE_ENABLED === 'true';
}

/**
 * Check if PayPal is enabled
 * Note: Uses PUBLIC_ prefix so it's available on client-side
 */
export function isPayPalEnabled(): boolean {
    if (typeof import.meta.env === 'undefined') return false;
    return import.meta.env.PUBLIC_PAYMENT_PAYPAL_ENABLED === 'true';
}

/**
 * Check if Bank Transfer (BACS) is enabled
 */
export function isBacsEnabled(): boolean {
    if (typeof import.meta.env === 'undefined') return false;
    return import.meta.env.PUBLIC_PAYMENT_BACS_ENABLED === 'true';
}

/**
 * Get all enabled payment gateways
 */
export function getEnabledGateways(): PaymentGateway[] {
    const gateways: PaymentGateway[] = [];
    
    if (isStripeEnabled()) {
        gateways.push({
            id: 'stripe',
            name: 'Credit Card',
            icon: '/icons/stripe.svg',
            enabled: true,
        });
    }
    
    if (isPayPalEnabled()) {
        gateways.push({
            id: 'paypal',
            name: 'PayPal',
            icon: '/icons/paypal.svg',
            enabled: true,
        });
    }
    
    if (isBacsEnabled()) {
        gateways.push({
            id: 'bacs',
            name: 'Direct Bank Transfer',
            icon: '',
            enabled: true,
        });
    }
    
    return gateways;
}

/**
 * Get gateway by ID
 */
export function getGateway(id: PaymentGatewayId): PaymentGateway | null {
    return getEnabledGateways().find(g => g.id === id) || null;
}

/**
 * Check if any payment gateway is enabled
 */
export function hasPaymentGateway(): boolean {
    return getEnabledGateways().length > 0;
}

// ============================================================================
// Client-side Payment Initialization
// ============================================================================

/**
 * Initialize payment gateway on client
 * Call this to load payment SDKs
 */
export async function initPaymentGateway(gatewayId: PaymentGatewayId): Promise<void> {
    switch (gatewayId) {
        case 'stripe':
            await initStripe();
            break;
        case 'paypal':
            await initPayPal();
            break;
    }
}

/**
 * Load Stripe.js
 */
async function initStripe(): Promise<void> {
    if (typeof window === 'undefined') return;
    if ((window as any).Stripe) return;
    
    const publishableKey = (import.meta as any).env?.PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) {
        console.error('Stripe publishable key not configured');
        return;
    }
    
    // Load Stripe.js dynamically
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.async = true;
    
    await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Stripe.js'));
        document.head.appendChild(script);
    });
    
    (window as any).stripeInstance = (window as any).Stripe(publishableKey);
}

/**
 * Load PayPal SDK
 */
async function initPayPal(): Promise<void> {
    if (typeof window === 'undefined') return;
    if ((window as any).paypal) return;
    
    const clientId = (import.meta as any).env?.PUBLIC_PAYPAL_CLIENT_ID;
    if (!clientId) {
        console.error('PayPal client ID not configured');
        return;
    }
    
    const currency = (import.meta as any).env?.PUBLIC_STORE_CURRENCY || 'USD';
    
    // Load PayPal SDK dynamically
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${clientId}&currency=${currency}`;
    script.async = true;
    
    await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load PayPal SDK'));
        document.head.appendChild(script);
    });
}

// ============================================================================
// Payment Session Creation (Client-side)
// ============================================================================

/**
 * Create payment session and redirect to payment page
 */
export async function createPaymentSession(
    gatewayId: PaymentGatewayId,
    orderId: number,
    orderKey: string
): Promise<PaymentSessionResponse> {
    try {
        const response = await fetch(`/api/payments/${gatewayId}/create-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_id: orderId, order_key: orderKey }),
        });
        
        const data = await response.json();
        
        if (!response.ok || !data.success) {
            return { 
                success: false, 
                error: data.error || 'Failed to create payment session' 
            };
        }
        
        return {
            success: true,
            redirect_url: data.redirect_url,
            session_id: data.session_id,
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Network error',
        };
    }
}

/**
 * Redirect to payment gateway
 */
export async function redirectToPayment(
    gatewayId: PaymentGatewayId,
    orderId: number,
    orderKey: string
): Promise<void> {
    const result = await createPaymentSession(gatewayId, orderId, orderKey);
    
    if (!result.success || !result.redirect_url) {
        throw new Error(result.error || 'Failed to create payment session');
    }
    
    // For Stripe Checkout, we might need to use their redirect method
    if (gatewayId === 'stripe' && result.session_id) {
        const stripe = (window as any).stripeInstance;
        if (stripe) {
            const { error } = await stripe.redirectToCheckout({ 
                sessionId: result.session_id 
            });
            if (error) {
                throw new Error(error.message);
            }
            return;
        }
    }
    
    // Default: direct redirect
    window.location.href = result.redirect_url;
}

// ============================================================================
// Inline Stripe Payment Element
// ============================================================================

let stripeElements: any = null;
let stripePaymentElement: any = null;

/**
 * Mount the Stripe Payment Element into a container.
 * Returns the Stripe and Elements instances for later use with confirmPayment.
 */
export async function mountStripePaymentElement(
    containerSelector: string
): Promise<{ stripe: any; elements: any } | null> {
    await initStripe();
    const stripe = (window as any).stripeInstance;
    if (!stripe) {
        console.error('Stripe not initialised');
        return null;
    }

    const appearance = { theme: 'stripe' as const };
    stripeElements = stripe.elements({ mode: 'payment', currency: 'usd', amount: 100, payment_method_types: ['card'], appearance });
    stripePaymentElement = stripeElements.create('payment', { layout: { type: 'tabs', defaultCollapsed: false } });

    const container = document.querySelector(containerSelector);
    if (!container) {
        console.error('Stripe Payment Element container not found:', containerSelector);
        return null;
    }

    stripePaymentElement.mount(container);
    return { stripe, elements: stripeElements };
}

/**
 * Unmount and destroy the Payment Element to free resources.
 */
export function unmountStripePaymentElement(): void {
    if (stripePaymentElement) {
        stripePaymentElement.unmount();
        stripePaymentElement = null;
    }
    stripeElements = null;
}

/**
 * Confirm inline Stripe payment after the WC order has been created.
 * 1. Calls /api/payments/stripe/create-intent to get a PaymentIntent client_secret
 * 2. Updates the Elements instance with the real client_secret
 * 3. Calls stripe.confirmPayment which handles 3DS if needed
 */
export async function confirmStripePayment(
    orderId: number,
    orderKey: string,
    returnUrl: string
): Promise<{ error?: string }> {
    const stripe = (window as any).stripeInstance;
    if (!stripe || !stripeElements) {
        return { error: 'Stripe not initialised' };
    }

    // Validate the Payment Element form first
    const { error: submitError } = await stripeElements.submit();
    if (submitError) {
        return { error: submitError.message };
    }

    // Create the PaymentIntent server-side
    const res = await fetch('/api/payments/stripe/create-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId, order_key: orderKey }),
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
        return { error: data.error || 'Failed to create payment intent' };
    }

    // Confirm the payment with the real client_secret
    const { error } = await stripe.confirmPayment({
        elements: stripeElements,
        clientSecret: data.client_secret,
        confirmParams: {
            return_url: returnUrl,
        },
    });

    if (error) {
        return { error: error.message };
    }

    return {};
}
