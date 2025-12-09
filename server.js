/**
 * Shopify App Proxy Server for Order Report
 * This server fetches order data including payment method and Stripe transaction details
 * Version: 1.1.0 - With shipping scope support
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { google } = require('googleapis');
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

// Google Sheets Configuration
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const GOOGLE_SHEETS_API_KEY = process.env.GOOGLE_SHEETS_API_KEY;

// Verify required environment variables
if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.error('❌ Missing required environment variables: SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN');
  process.exit(1);
}

// Customer data cache from Google Sheets
let customerDataCache = {};
let lastCacheUpdate = null;

/**
 * Utility: Sleep for specified milliseconds
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch customer data from Google Sheets (public sheet via CSV export)
 */
async function fetchCustomerDataFromSheets() {
  if (!GOOGLE_SHEETS_ID) {
    console.log('⚠️  Google Sheets not configured, skipping customer data sync');
    return {};
  }

  try {
    console.log('📊 Fetching customer data from Google Sheets...');
    
    // Use public CSV export URL (works for public sheets without API key)
    const csvUrl = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}/export?format=csv`;
    const response = await axios.get(csvUrl, {
      maxRedirects: 5,
      validateStatus: (status) => status < 400
    });
    
    if (!response.data) {
      console.log('⚠️  No data found in Google Sheets');
      return {};
    }

    // Parse CSV data
    const lines = response.data.split('\n');
    const rows = lines.map(line => {
      // Simple CSV parser (handles quoted fields)
      const result = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current);
      return result;
    });

    if (rows.length === 0) {
      console.log('⚠️  No data found in Google Sheets');
      return {};
    }

    // Parse headers and data
    const headers = rows[0].map(h => (h || '').toLowerCase().trim().replace(/"/g, ''));
    const customerData = {};

    console.log(`📋 Sheet headers: ${headers.join(' | ')}`);
    console.log(`📊 Total rows: ${rows.length}`);

    // Find column indexes (flexible matching)
    const orderIdIndex = headers.findIndex(h => 
      h.includes('id') || h.includes('number') || h.includes('name')
    );
    const firstNameIndex = headers.findIndex(h => 
      (h.includes('first') && h.includes('name')) || h === 'first name' || h.includes('shipping') && h.includes('first')
    );
    const lastNameIndex = headers.findIndex(h => 
      (h.includes('last') && h.includes('name')) || h === 'last name' || h.includes('shipping') && h.includes('last')
    );
    const emailIndex = headers.findIndex(h => h.includes('email'));
    const phoneIndex = headers.findIndex(h => h.includes('phone'));
    const addressIndex = headers.findIndex(h => 
      (h.includes('address') || h.includes('street')) && !h.includes('2')
    );
    const cityIndex = headers.findIndex(h => h.includes('city'));
    const provinceIndex = headers.findIndex(h => h.includes('province') || h.includes('state'));
    const zipIndex = headers.findIndex(h => h.includes('zip') || h.includes('postal'));
    const countryIndex = headers.findIndex(h => h.includes('country'));

    console.log(`🔍 Column indexes - Order: ${orderIdIndex}, Name: ${firstNameIndex}/${lastNameIndex}, Email: ${emailIndex}`);

    // Process each row
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const orderIdentifier = row[orderIdIndex]?.trim();
      if (!orderIdentifier) continue;

      // Extract order number from various formats (#1033, 1033, etc.)
      const orderNum = orderIdentifier.replace(/[^0-9]/g, '');
      
      customerData[orderNum] = {
        first_name: row[firstNameIndex] || null,
        last_name: row[lastNameIndex] || null,
        email: row[emailIndex] || null,
        phone: row[phoneIndex] || null,
        address1: row[addressIndex] || null,
        city: row[cityIndex] || null,
        province: row[provinceIndex] || null,
        zip: row[zipIndex] || null,
        country: row[countryIndex] || null
      };
    }

    console.log(`✅ Loaded customer data for ${Object.keys(customerData).length} orders from Google Sheets`);
    return customerData;
  } catch (error) {
    console.error('❌ Error fetching from Google Sheets:', error.message);
    return {};
  }
}

/**
 * Refresh customer data cache from Google Sheets
 */
async function refreshCustomerDataCache() {
  customerDataCache = await fetchCustomerDataFromSheets();
  lastCacheUpdate = new Date();
  return customerDataCache;
}

// Initialize cache on startup
refreshCustomerDataCache().catch(err => console.error('Failed to initialize customer data cache:', err));

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
 * Enrich order with customer data from Google Sheets (fast, no API calls)
 */
function enrichOrderWithCustomerData(order) {
  // Try to get customer data from Google Sheets cache first
  const orderNumber = order.order_number?.toString() || order.number?.toString();
  const sheetsData = customerDataCache[orderNumber];
    
    // Merge data: Google Sheets > Shopify API > fallbacks
    const customerInfo = {
      id: order.customer?.id || null,
      email: sheetsData?.email || order.customer?.email || order.email || order.contact_email || null,
      first_name: sheetsData?.first_name || order.customer?.first_name || order.shipping_address?.first_name || order.billing_address?.first_name || null,
      last_name: sheetsData?.last_name || order.customer?.last_name || order.shipping_address?.last_name || order.billing_address?.last_name || null,
      phone: sheetsData?.phone || order.customer?.phone || order.phone || order.shipping_address?.phone || order.billing_address?.phone || null,
      accepts_marketing: order.customer?.accepts_marketing || false,
      full_name: null
    };
    
    // Build full name
    if (customerInfo.first_name || customerInfo.last_name) {
      customerInfo.full_name = [customerInfo.first_name, customerInfo.last_name].filter(Boolean).join(' ');
    }
    
    // Merge shipping address with Google Sheets data
    const shippingAddress = {
      first_name: sheetsData?.first_name || order.shipping_address?.first_name || customerInfo.first_name,
      last_name: sheetsData?.last_name || order.shipping_address?.last_name || customerInfo.last_name,
      name: sheetsData?.first_name || sheetsData?.last_name ? `${sheetsData.first_name || ''} ${sheetsData.last_name || ''}`.trim() : order.shipping_address?.name,
      address1: sheetsData?.address1 || order.shipping_address?.address1 || null,
      address2: order.shipping_address?.address2 || null,
      city: sheetsData?.city || order.shipping_address?.city || null,
      province: sheetsData?.province || order.shipping_address?.province || null,
      province_code: order.shipping_address?.province_code || null,
      zip: sheetsData?.zip || order.shipping_address?.zip || null,
      country: sheetsData?.country || order.shipping_address?.country || null,
      country_code: order.shipping_address?.country_code || null,
      phone: sheetsData?.phone || order.shipping_address?.phone || customerInfo.phone,
      company: order.shipping_address?.company || null
    };
    
  return {
    ...order,
    customer: order.customer || customerInfo,
    customer_info: customerInfo,
    shipping_address: shippingAddress,
    billing_address: order.billing_address || null
  };
}

/**
 * Fetch variant details to get SKU and barcode
 */
async function fetchVariantDetails(variantId) {
  try {
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/variants/${variantId}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data.variant;
  } catch (error) {
    console.error(`Error fetching variant ${variantId}:`, error.message);
    return null;
  }
}

/**
 * Enrich line items with SKU and barcode from variant data
 */
async function enrichLineItemsWithSKU(lineItems) {
  const enrichedItems = [];
  console.log(`🔍 Enriching ${lineItems.length} line items with SKU...`);
  
  for (const item of lineItems) {
    // If item already has SKU, keep it as is
    if (item.sku) {
      console.log(`✅ Item "${item.name}" already has SKU: ${item.sku}`);
      enrichedItems.push(item);
      continue;
    }
    
    // If no SKU and has variant_id, fetch variant details
    if (item.variant_id) {
      console.log(`🔄 Fetching SKU for "${item.name}" (variant_id: ${item.variant_id})...`);
      const variant = await fetchVariantDetails(item.variant_id);
      if (variant) {
        console.log(`✅ Found SKU for "${item.name}": ${variant.sku}`);
        enrichedItems.push({
          ...item,
          sku: variant.sku || null,
          barcode: variant.barcode || null
        });
      } else {
        console.log(`❌ Failed to fetch variant details for "${item.name}"`);
        enrichedItems.push(item);
      }
    } else {
      console.log(`⚠️ Item "${item.name}" has no variant_id`);
      enrichedItems.push(item);
    }
  }
  
  console.log(`✅ Enrichment complete: ${enrichedItems.filter(i => i.sku).length}/${lineItems.length} items have SKU`);
  return enrichedItems;
}

/**
 * Enrich order data with transaction details and customer info
 */
async function enrichOrderWithTransactions(order) {
  try {
    // First enrich with customer data from Sheets
    const enrichedOrder = enrichOrderWithCustomerData(order);
    
    // Enrich line items with SKU for bundle products
    if (enrichedOrder.line_items && enrichedOrder.line_items.length > 0) {
      enrichedOrder.line_items = await enrichLineItemsWithSKU(enrichedOrder.line_items);
    }
    
    // Then add transactions
    const transactions = await fetchOrderTransactions(enrichedOrder.id);
    
    return {
      ...enrichedOrder,
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
      created_at_max,
      include_transactions = 'true' // Optional: set to 'false' to skip transaction enrichment
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

    // Always enrich with customer data from Google Sheets (fast)
    console.log('👥 Enriching orders with customer data from Google Sheets...');
    let enrichedOrders = orders.map(order => enrichOrderWithCustomerData(order));
    
    // Only enrich with transactions if requested (this is slow due to rate limits)
    if (include_transactions === 'true') {
      enrichedOrders = [];
      console.log('🔄 Enriching orders with transaction details (batch processing)...');
      enrichedOrders = [];
      
      // Process in batches of 5 to balance speed and rate limits
      const batchSize = 5;
      for (let i = 0; i < orders.length; i += batchSize) {
        const batch = orders.slice(i, i + batchSize);
        const batchPromises = batch.map(order => enrichOrderWithTransactions(order));
        const batchResults = await Promise.all(batchPromises);
        enrichedOrders.push(...batchResults);
        
        // Small delay between batches (100ms)
        if (i + batchSize < orders.length) {
          await sleep(100);
        }
      }
      console.log('✅ All orders enriched successfully');
    } else {
      console.log('⚡ Skipping transaction enrichment for faster response');
    }

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
    timestamp: new Date().toISOString(),
    cache_status: {
      has_customer_data: Object.keys(customerDataCache).length > 0,
      customer_count: Object.keys(customerDataCache).length,
      last_update: lastCacheUpdate
    }
  });
});

/**
 * Refresh Google Sheets customer data cache
 */
app.post('/apps/order-report-proxy/refresh-customer-data', async (req, res) => {
  try {
    console.log('🔄 Manual refresh of customer data requested...');
    await refreshCustomerDataCache();
    res.json({
      success: true,
      message: 'Customer data cache refreshed successfully',
      customer_count: Object.keys(customerDataCache).length,
      last_update: lastCacheUpdate
    });
  } catch (error) {
    console.error('❌ Error refreshing customer data:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh customer data',
      message: error.message
    });
  }
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
