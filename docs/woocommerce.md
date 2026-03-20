# WooCommerce Store Reference

This is a WooCommerce storefront. Products are pre-rendered from synced JSON data.
Cart is client-side (nanostores + localStorage). Checkout/orders/auth use live WooCommerce API.

## Product Data (src/lib/local-product-data.ts)

All functions are async:
```typescript
getLocalProducts()                    // All products
getLocalProduct(slug)                 // Single by slug
getLocalCategories()                  // All categories
getLocalVisibleCategories()           // Categories with count > 0
getLocalProductsByCategory(slug)      // By category slug
getLocalFeaturedProducts(limit)       // Featured products
getLocalRelatedProducts(product, limit) // Related by category/tag
```

## WooCommerce Helpers (src/lib/woocommerce.ts)
```typescript
formatPrice(price)             // Format with currency symbol
isInStock(product)             // boolean
getDiscountPercentage(product) // number (e.g. 25)
stripHtml(html)                // Remove HTML tags
```

## Cart (src/lib/cart.ts) - client-side nanostores
```typescript
$cart, $cartCount, $cartTotal          // Reactive state
addToCart(item), removeFromCart(id), updateQuantity(id, qty), clearCart()
getLineItems()                         // For order creation: [{ product_id, quantity }]
openCartDrawer(), closeCartDrawer()    // Cart drawer control
initCart()                             // Initialize from localStorage
```
CartItem: { id, name, price, quantity, image?, variation_id? }

## Auth (src/lib/auth.ts) - JWT-based (WordPress JWT plugin)
WP admin is locked down - all auth goes through Astro API routes.
```typescript
$isLoggedIn, $user, $token             // Reactive state
login(email, password)                 // { success, error? }
register({ email, password, firstName?, lastName? })
logout(), getToken(), initAuth()
requestPasswordReset(email)            // { success, error? } - sends reset email
```
Password reset: /forgot-password -> signed JWT token (1h) -> /reset-password?token=... -> updates via WC REST API.

## Payments (src/lib/payments.ts)
```typescript
redirectToPayment('stripe', orderId, orderKey)
redirectToPayment('paypal', orderId, orderKey)
getEnabledGateways()  // [{ id, name }]
```

## API Routes (src/pages/api/)

All use `export const prerender = false;`

| Route | Method | Purpose |
|-------|--------|---------|
| /api/orders/create | POST | Create WooCommerce order |
| /api/orders/[orderId] | GET | Fetch order by ID (requires order_key) |
| /api/stock/check | POST | Validate stock before checkout |
| /api/checkout/config | GET | Payment gateways, shipping, customer addresses |
| /api/auth/login | POST | Customer login (JWT) |
| /api/auth/register | POST | Create WooCommerce customer |
| /api/auth/validate | POST | Validate JWT token |
| /api/auth/forgot-password | POST | Send password reset email (signed JWT) |
| /api/auth/reset-password | POST | Verify token and update password via WC API |
| /api/customer/me | GET | Current customer data |
| /api/customer/orders | GET | Customer order history |
| /api/customer/orders/[id] | GET | Single order detail (verified ownership) |
| /api/customer/addresses | GET/PUT | Billing/shipping addresses |
| /api/customer/settings | PUT | Update name and password |
| /api/payments/stripe/create-session | POST | Stripe Checkout session (redirect flow) |
| /api/payments/stripe/create-intent | POST | Stripe PaymentIntent (inline Payment Element) |
| /api/payments/stripe/webhook | POST | Stripe webhook |
| /api/payments/paypal/create-session | POST | PayPal order |
| /api/payments/paypal/capture | POST | PayPal capture |

## Pages

| Route | File |
|-------|------|
| / | src/pages/index.astro (homepage) |
| /shop | src/pages/shop/index.astro (product grid) |
| /shop/product/[slug] | src/pages/shop/product/[slug].astro |
| /shop/category/[slug] | src/pages/shop/category/[slug].astro |
| /cart | src/pages/cart.astro |
| /checkout | src/pages/checkout.astro |
| /order-complete | src/pages/order-complete.astro |
| /search | src/pages/search.astro (product search) |
| /login | src/pages/login.astro |
| /register | src/pages/register.astro |
| /forgot-password | src/pages/forgot-password.astro |
| /reset-password | src/pages/reset-password.astro |
| /account | src/pages/account/index.astro |
| /account/orders | src/pages/account/orders/index.astro |
| /account/orders/[id] | src/pages/account/orders/[id].astro |
| /account/addresses | src/pages/account/addresses.astro |
| /account/settings | src/pages/account/settings.astro |

## Components

Astro (src/components/shop/): ProductCard.astro, ProductImage.astro, AddToCartButton.astro, CartDrawer.astro
React (src/components/react/): CartDrawer.tsx, AddToCartButton.tsx, ProductCard.tsx, ProductImage.tsx, RecentOrders.tsx
Use `client:load` for React component hydration.

## Environment Variables (.env)

Required: WC_API_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET, WC_ACCESS_SECRET, JWT_SECRET
Optional (payments): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MODE, PUBLIC_SITE_URL

## Generated Files (DO NOT MODIFY)

In addition to the base generated files, these WooCommerce files are auto-generated:
- src/lib/woocommerce.ts, src/lib/cart.ts, src/lib/auth.ts, src/lib/payments.ts
- src/lib/local-product-data.ts, src/lib/product-media.ts
- src/pages/api/**/*.ts (all API routes)
- src/components/shop/*.astro, src/components/react/*.tsx

Create new files instead of modifying generated ones.
