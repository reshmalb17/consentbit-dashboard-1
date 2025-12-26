// Pretty database viewer for D1
// Usage: node view-db.js

const { execSync } = require('child_process');

const DB_NAME = 'consentbit-licenses';
const REMOTE = '--remote';

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function formatCurrency(amount, currency = 'usd') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase()
  }).format(amount / 100);
}

function formatDate(timestamp) {
  return new Date(timestamp * 1000).toLocaleString();
}

function formatTable(data, columns) {
  if (!data || data.length === 0) {
    return 'No data found';
  }

  // Calculate column widths
  const widths = {};
  columns.forEach(col => {
    widths[col] = Math.max(
      col.length,
      ...data.map(row => String(row[col] || '').length)
    );
  });

  // Create header
  const header = columns.map(col => col.padEnd(widths[col])).join(' | ');
  const separator = columns.map(col => '-'.repeat(widths[col])).join('-|-');

  // Create rows
  const rows = data.map(row => 
    columns.map(col => String(row[col] || '').padEnd(widths[col])).join(' | ')
  );

  return [header, separator, ...rows].join('\n');
}

function queryDB(sql) {
  try {
    // Clean up SQL - remove extra whitespace and newlines
    const cleanSQL = sql.replace(/\s+/g, ' ').trim();
    const command = `npx wrangler d1 execute ${DB_NAME} ${REMOTE} --json --command "${cleanSQL.replace(/"/g, '\\"')}"`;
    const output = execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    
    // Parse JSON output from wrangler
    try {
      const result = JSON.parse(output);
      // wrangler returns: [{ results: [...], success: true, meta: {...} }]
      if (Array.isArray(result) && result.length > 0 && result[0].results) {
        return result[0].results;
      }
      // Fallback for other formats
      if (result.results && Array.isArray(result.results)) {
        return result.results;
      }
      if (Array.isArray(result)) {
        return result;
      }
      return [];
    } catch (e) {
      // If JSON parse fails, return empty
      return [];
    }
  } catch (error) {
    // Don't print error for empty results
    if (!error.message.includes('must provide') && !error.message.includes('Authentication')) {
      console.error(colors.red + 'Error querying database:' + colors.reset, error.message);
    }
    return [];
  }
}


// Payments
const payments = queryDB(`SELECT id, customer_id, email, amount, currency, status, magic_link, created_at FROM payments ORDER BY created_at DESC LIMIT 20`);

if (payments.length > 0) {
  payments.forEach((p, i) => {
    const hasLink = p.magic_link && p.magic_link.trim() !== '';
    if (p.created_at) {
      const date = typeof p.created_at === 'number' ? new Date(p.created_at * 1000).toLocaleString() : p.created_at;
    }
    if (hasLink) {
    }
  });
} else {
}

// Licenses
const licenses = queryDB(`SELECT id, customer_id, subscription_id, license_key, status, datetime(created_at, 'unixepoch') as created_at FROM licenses ORDER BY created_at DESC LIMIT 20`);

if (licenses.length > 0) {
  licenses.forEach((l, i) => {
    if (l.created_at) {
      const date = typeof l.created_at === 'number' ? new Date(l.created_at * 1000).toLocaleString() : l.created_at;
    }
  });
} else {
}

// Summary

const paymentCount = queryDB('SELECT COUNT(*) as count FROM payments');
const licenseCount = queryDB('SELECT COUNT(*) as count FROM licenses');
const activeLicenses = queryDB("SELECT COUNT(*) as count FROM licenses WHERE status = 'active'");



