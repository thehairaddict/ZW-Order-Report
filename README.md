# 🔌 ZW Order Report - App Proxy Server

Node.js Express server that acts as a Shopify app proxy to fetch order data with payment details.

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your Shopify credentials:

```env
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PORT=3000
```

### 3. Run Locally

```bash
# Development with auto-reload
npm run dev

# Production
npm start
```

## 📡 API Endpoints

### GET `/apps/order-report-proxy/orders`

Fetch all orders with transaction details.

**Query Parameters:**
- `limit` (number): Max orders to return (default: 250)
- `status` (string): Order status filter
- `financial_status` (string): Financial status filter
- `created_at_min` (ISO date): Start date filter
- `created_at_max` (ISO date): End date filter

**Example:**
```bash
curl http://localhost:3000/apps/order-report-proxy/orders?limit=50
```

**Response:**
```json
{
  "success": true,
  "count": 50,
  "orders": [
    {
      "id": 123456789,
      "order_number": 1001,
      "name": "#1001",
      "created_at": "2024-01-15T10:30:00Z",
      "total_price": "99.99",
      "currency": "USD",
      "financial_status": "paid",
      "customer": {...},
      "payment_gateway_names": ["Stripe"],
      "transactions": [
        {
          "id": 987654321,
          "authorization": "ch_1234567890abcdef",
          "gateway": "stripe",
          "kind": "sale",
          "status": "success",
          "amount": "99.99"
        }
      ]
    }
  ]
}
```

### GET `/apps/order-report-proxy/orders/:orderId`

Fetch specific order details.

**Example:**
```bash
curl http://localhost:3000/apps/order-report-proxy/orders/123456789
```

### GET `/apps/order-report-proxy/health`

Health check endpoint.

**Response:**
```json
{
  "success": true,
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### POST `/apps/order-report-proxy/graphql`

Execute GraphQL queries (optional advanced usage).

**Example:**
```bash
curl -X POST http://localhost:3000/apps/order-report-proxy/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "{ orders(first: 10) { edges { node { id name } } } }"
  }'
```

## 🔒 Security

- Never expose your `.env` file
- Use HTTPS in production
- Restrict CORS origins if needed
- Implement rate limiting for production use

## 📦 Deployment

### Heroku

```bash
heroku create zw-order-report-proxy
heroku config:set SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
heroku config:set SHOPIFY_ACCESS_TOKEN=shpat_xxx
git push heroku main
```

### Vercel

```bash
vercel
# Add environment variables in Vercel dashboard
```

### Docker

```bash
docker build -t zw-order-report .
docker run -p 3000:3000 --env-file .env zw-order-report
```

## 🐛 Debugging

### Enable Verbose Logging

Set `DEBUG` environment variable:

```bash
DEBUG=* npm start
```

### Test Endpoints

```bash
# Health check
curl http://localhost:3000/apps/order-report-proxy/health

# Test orders endpoint
curl http://localhost:3000/apps/order-report-proxy/orders?limit=5
```

### Common Issues

**401 Unauthorized**
- Check your access token
- Verify API scopes in Shopify app settings

**Empty orders array**
- Store may have no orders
- Check date filters

**CORS errors**
- Verify proxy URL in Shopify settings
- Check CORS middleware configuration

## 📚 Resources

- [Shopify Admin API](https://shopify.dev/docs/api/admin-rest)
- [App Proxy](https://shopify.dev/docs/apps/online-store/app-proxies)
- [Express Documentation](https://expressjs.com/)

## 📝 License

MIT
