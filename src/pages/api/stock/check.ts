/**
 * Check Stock API Route
 * 
 * POST /api/stock/check
 * Validates stock availability for cart items before checkout
 * 
 * This provides real-time stock validation to prevent overselling,
 * even if the static product pages show older stock data.
 */

import type { APIRoute } from 'astro';

// WooCommerce API configuration
const WC_API_URL = import.meta.env.WC_API_URL;
const WC_CONSUMER_KEY = import.meta.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = import.meta.env.WC_CONSUMER_SECRET;
const WC_ACCESS_SECRET = import.meta.env.WC_ACCESS_SECRET;

interface StockCheckItem {
    product_id: number;
    variation_id?: number;
    quantity: number;
}

interface StockCheckResult {
    product_id: number;
    variation_id?: number;
    name: string;
    requested_quantity: number;
    available_quantity: number | null;
    in_stock: boolean;
    stock_status: string;
    backorders_allowed: boolean;
    available: boolean;
    message?: string;
}

/**
 * Helper to make authenticated WooCommerce API requests
 */
async function wcRequest(endpoint: string) {
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

/**
 * Check stock for a single product or variation
 */
async function checkProductStock(item: StockCheckItem): Promise<StockCheckResult> {
    try {
        // Fetch product (or variation if specified)
        const endpoint = item.variation_id 
            ? `products/${item.product_id}/variations/${item.variation_id}`
            : `products/${item.product_id}`;
        
        const response = await wcRequest(endpoint);
        
        if (!response.ok) {
            return {
                product_id: item.product_id,
                variation_id: item.variation_id,
                name: 'Unknown Product',
                requested_quantity: item.quantity,
                available_quantity: null,
                in_stock: false,
                stock_status: 'unknown',
                backorders_allowed: false,
                available: false,
                message: 'Product not found',
            };
        }
        
        const product = await response.json();
        
        // Check stock status
        const stockStatus = product.stock_status || 'instock';
        const inStock = stockStatus === 'instock' || stockStatus === 'onbackorder';
        const backordersAllowed = product.backorders === 'yes' || product.backorders === 'notify';
        const stockQuantity = product.stock_quantity;
        const manageStock = product.manage_stock;
        
        // Determine if requested quantity is available
        let available = true;
        let message: string | undefined;
        
        if (stockStatus === 'outofstock') {
            available = false;
            message = 'This product is out of stock';
        } else if (manageStock && stockQuantity !== null) {
            if (item.quantity > stockQuantity) {
                if (backordersAllowed) {
                    available = true;
                    message = `Only ${stockQuantity} in stock, ${item.quantity - stockQuantity} will be backordered`;
                } else {
                    available = false;
                    message = `Only ${stockQuantity} available in stock`;
                }
            }
        }
        
        // Get product name (handle variation naming)
        let productName = product.name;
        if (item.variation_id && product.attributes) {
            const attrStr = product.attributes
                .map((attr: any) => attr.option)
                .join(', ');
            if (attrStr) {
                // We need to fetch parent product name for variations
                const parentResponse = await wcRequest(`products/${item.product_id}`);
                if (parentResponse.ok) {
                    const parent = await parentResponse.json();
                    productName = `${parent.name} - ${attrStr}`;
                }
            }
        }
        
        return {
            product_id: item.product_id,
            variation_id: item.variation_id,
            name: productName,
            requested_quantity: item.quantity,
            available_quantity: stockQuantity,
            in_stock: inStock,
            stock_status: stockStatus,
            backorders_allowed: backordersAllowed,
            available,
            message,
        };
    } catch (error) {
        return {
            product_id: item.product_id,
            variation_id: item.variation_id,
            name: 'Unknown Product',
            requested_quantity: item.quantity,
            available_quantity: null,
            in_stock: false,
            stock_status: 'error',
            backorders_allowed: false,
            available: false,
            message: error instanceof Error ? error.message : 'Failed to check stock',
        };
    }
}

export const POST: APIRoute = async ({ request }) => {
    try {
        const { items } = await request.json();
        
        // Validate request
        if (!items || !Array.isArray(items) || items.length === 0) {
            return new Response(
                JSON.stringify({ 
                    success: false, 
                    error: 'No items provided for stock check' 
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        // Check stock for all items
        const results: StockCheckResult[] = await Promise.all(
            items.map((item: StockCheckItem) => checkProductStock(item))
        );
        
        // Determine overall availability
        const allAvailable = results.every(result => result.available);
        const unavailableItems = results.filter(result => !result.available);
        
        return new Response(
            JSON.stringify({
                success: true,
                all_available: allAvailable,
                results,
                unavailable_items: unavailableItems,
                message: allAvailable 
                    ? 'All items are available' 
                    : `${unavailableItems.length} item(s) have stock issues`,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Stock check error:', error);
        return new Response(
            JSON.stringify({ 
                success: false, 
                error: error instanceof Error ? error.message : 'Stock check failed' 
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};
