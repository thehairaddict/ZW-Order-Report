/**
 * Shopify App Proxy Server for Order Report
 * This server fetches order data including payment method and Stripe transaction details
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware - Configure CORS to allow Shopify store
app.use(cors({
  origin: [
    'https://kx9qdv-7b.myshopify.com',
    'https://ksa.thehairaddict.net',
    /\.myshopify\.com$/,
    /\.thehairaddict\.net$/
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Shopify API Configuration
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN; // e.g., 'your-store.myshopify.com'
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // Admin API access token

// Verify required environment variables
if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.error('❌ Missing required environment variables: SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN');
  process.exit(1);
}

/**
 * Utility: Sleep for specified milliseconds
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Utility: Retry function with exponential backoff
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.response?.status === 429 && i < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, i);
        console.log(`⏳ Rate limited. Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
}

/**
 * Fetch orders from Shopify with payment details
 */
async function fetchShopifyOrders(params = {}) {
  try {
    const {
      limit = 250,
      status = 'any',
      financial_status,
      created_at_min,
      created_at_max
    } = params;

    // Build query parameters - omit fields to get complete order data including customer
    const queryParams = new URLSearchParams({
      limit: limit.toString(),
      status,
      ...(financial_status && { financial_status }),
      ...(created_at_min && { created_at_min }),
      ...(created_at_max && { created_at_max })
    });

    // Fetch orders using REST Admin API
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?${queryParams}`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.orders;
  } catch (error) {
    console.error('Error fetching orders from Shopify:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Fetch detailed order information including transactions
 */
async function fetchOrderDetails(orderId) {
  try {
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/orders/${orderId}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.order;
  } catch (error) {
    console.error(`Error fetching order ${orderId}:`, error.response?.data || error.message);
    return null;
  }
}

/**
 * Fetch transactions for an order with retry logic
 */
async function fetchOrderTransactions(orderId) {
  try {
    return await retryWithBackoff(async () => {
      const response = await axios.get(
        `https://${SHOPIFY_STORE}/admin/api/2024-01/orders/${orderId}/transactions.json`,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data.transactions;
    });
  } catch (error) {
    console.error(`❌ Error fetching transactions for order ${orderId}:`, error.response?.status || error.message);
    return [];
  }
}

/**
 * Enrich order data with transaction details and normalized customer info
 */
async function enrichOrderWithTransactions(order) {
  try {
    const transactions = await fetchOrderTransactions(order.id);
    
    // Normalize customer data - handle guest checkouts
    const customerInfo = {
      id: order.customer?.id || null,
      email: order.customer?.email || order.email || order.contact_email || null,
      first_name: order.customer?.first_name || order.shipping_address?.first_name || order.billing_address?.first_name || null,
      last_name: order.customer?.last_name || order.shipping_address?.last_name || order.billing_address?.last_name || null,
      phone: order.customer?.phone || order.phone || order.shipping_address?.phone || order.billing_address?.phone || null,
      accepts_marketing: order.customer?.accepts_marketing || false,
      full_name: null
    };
    
    // Build full name
    if (customerInfo.first_name || customerInfo.last_name) {
      customerInfo.full_name = [customerInfo.first_name, customerInfo.last_name].filter(Boolean).join(' ');
    }
    
    // Log if customer data is missing
    if (!customerInfo.full_name && !customerInfo.email) {
      console.log(`⚠️  Order ${order.order_number || order.id} has no customer data`);
    }
    
    return {
      ...order,
      customer: order.customer || customerInfo, // Keep original if exists, else use normalized
      customer_info: customerInfo, // Always include normalized version
      shipping_address: order.shipping_address || null,
      billing_address: order.billing_address || null,
      transactions: transactions.map(t => ({
        id: t.id,
        authorization: t.authorization,
        gateway: t.gateway,
        kind: t.kind,
        status: t.status,
        amount: t.amount,
        currency: t.currency,
        receipt: t.receipt,
        created_at: t.created_at
      }))
    };
  } catch (error) {
    console.error(`Error enriching order ${order.id}:`, error.message);
    return order;
  }
}

/**
 * Main endpoint: Get orders with payment details
 */
app.get('/apps/order-report-proxy/orders', async (req, res) => {
  try {
    console.log('📊 Fetching orders...');
    
    // Get query parameters
    const {
      limit,
      status,
      financial_status,
      created_at_min,
      created_at_max
    } = req.query;

    // Fetch orders
    const orders = await fetchShopifyOrders({
      limit: limit ? parseInt(limit) : 250,
      status,
      financial_status,
      created_at_min,
      created_at_max
    });

    console.log(`✅ Found ${orders.length} orders`);

    // Enrich orders with transaction details sequentially to avoid rate limits
    console.log('🔄 Enriching orders with transaction details...');
    const enrichedOrders = [];
    for (let i = 0; i < orders.length; i++) {
      const enrichedOrder = await enrichOrderWithTransactions(orders[i]);
      enrichedOrders.push(enrichedOrder);
      
      // Add delay between requests to respect rate limits (500ms between each)
      if (i < orders.length - 1) {
        await sleep(500);
      }
    }
    console.log('✅ All orders enriched successfully');

    res.json({
      success: true,
      count: enrichedOrders.length,
      orders: enrichedOrders
    });
  } catch (error) {
    console.error('❌ Error in /orders endpoint:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch orders',
      message: error.message
    });
  }
});

/**
 * Get specific order details
 */
app.get('/apps/order-report-proxy/orders/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    console.log(`📊 Fetching order ${orderId}...`);

    const order = await fetchOrderDetails(orderId);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    const enrichedOrder = await enrichOrderWithTransactions(order);

    res.json({
      success: true,
      order: enrichedOrder
    });
  } catch (error) {
    console.error(`❌ Error fetching order:`, error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch order',
      message: error.message
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/apps/order-report-proxy/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

/**
 * Debug endpoint: View raw order data for troubleshooting
 */
app.get('/apps/order-report-proxy/debug/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    console.log(`🔍 DEBUG: Fetching raw order ${orderId}...`);

    const order = await fetchOrderDetails(orderId);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    // Return raw order data with highlighted customer fields
    res.json({
      success: true,
      debug_info: {
        has_customer: !!order.customer,
        has_shipping_address: !!order.shipping_address,
        has_billing_address: !!order.billing_address,
        customer_fields: {
          customer_object: order.customer,
          email: order.email,
          contact_email: order.contact_email,
          phone: order.phone
        },
        shipping_address: order.shipping_address,
        billing_address: order.billing_address
      },
      raw_order: order
    });
  } catch (error) {
    console.error(`❌ DEBUG Error:`, error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch order',
      message: error.message
    });
  }
});

/**
 * GraphQL endpoint for more complex queries (optional)
 */
app.post('/apps/order-report-proxy/graphql', async (req, res) => {
  try {
    const { query, variables } = req.body;

    const response = await axios.post(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
      { query, variables },
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('❌ GraphQL Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'GraphQL query failed',
      message: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Order Report Proxy Server running on port ${PORT}`);
  console.log(`📍 Store: ${SHOPIFY_STORE}`);
  console.log(`✅ Ready to fetch orders with payment details`);
});

module.exports = app;
