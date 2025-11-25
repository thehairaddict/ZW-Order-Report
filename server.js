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

// Middleware
app.use(cors());
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

    // Build query parameters
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
 * Fetch transactions for an order
 */
async function fetchOrderTransactions(orderId) {
  try {
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
  } catch (error) {
    console.error(`Error fetching transactions for order ${orderId}:`, error.message);
    return [];
  }
}

/**
 * Enrich order data with transaction details
 */
async function enrichOrderWithTransactions(order) {
  try {
    const transactions = await fetchOrderTransactions(order.id);
    
    return {
      ...order,
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

    // Enrich orders with transaction details
    const enrichedOrders = await Promise.all(
      orders.map(order => enrichOrderWithTransactions(order))
    );

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
