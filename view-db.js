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

console.log('\n' + colors.cyan + '='.repeat(80) + colors.reset);
console.log(colors.bright + colors.cyan + '📊 DATABASE VIEWER - ConsentBit Dashboard' + colors.reset);
console.log(colors.cyan + '='.repeat(80) + colors.reset + '\n');

// Payments
console.log(colors.bright + colors.magenta + '💳 PAYMENTS TABLE' + colors.reset);
console.log(colors.dim + '-'.repeat(80) + colors.reset);
const payments = queryDB(`SELECT id, customer_id, email, amount, currency, status, magic_link, created_at FROM payments ORDER BY created_at DESC LIMIT 20`);

if (payments.length > 0) {
  payments.forEach((p, i) => {
    console.log(`\n${colors.blue}[${i + 1}]${colors.reset} ${colors.bright}Payment ID:${colors.reset} ${colors.yellow}${p.id}${colors.reset}`);
    console.log(`    ${colors.dim}Customer:${colors.reset} ${p.customer_id}`);
    console.log(`    ${colors.dim}Email:${colors.reset} ${colors.cyan}${p.email}${colors.reset}`);
    console.log(`    ${colors.dim}Amount:${colors.reset} ${colors.green}${formatCurrency(p.amount, p.currency)}${colors.reset}`);
    console.log(`    ${colors.dim}Status:${colors.reset} ${p.status === 'succeeded' ? colors.green : colors.yellow}${p.status}${colors.reset}`);
    const hasLink = p.magic_link && p.magic_link.trim() !== '';
    console.log(`    ${colors.dim}Magic Link:${colors.reset} ${hasLink ? colors.green + '✓ Yes' : colors.red + '✗ No'}${colors.reset}`);
    if (p.created_at) {
      const date = typeof p.created_at === 'number' ? new Date(p.created_at * 1000).toLocaleString() : p.created_at;
      console.log(`    ${colors.dim}Created:${colors.reset} ${date}`);
    }
    if (hasLink) {
      console.log(`    ${colors.dim}Link:${colors.reset} ${colors.cyan}${p.magic_link.substring(0, 80)}...${colors.reset}`);
    }
  });
} else {
  console.log(colors.yellow + 'No payments found' + colors.reset);
}

// Licenses
console.log('\n\n' + colors.cyan + '='.repeat(80) + colors.reset);
console.log(colors.bright + colors.magenta + '🔑 LICENSES TABLE' + colors.reset);
console.log(colors.dim + '-'.repeat(80) + colors.reset);
const licenses = queryDB(`SELECT id, customer_id, subscription_id, license_key, status, datetime(created_at, 'unixepoch') as created_at FROM licenses ORDER BY created_at DESC LIMIT 20`);

if (licenses.length > 0) {
  licenses.forEach((l, i) => {
    console.log(`\n${colors.blue}[${i + 1}]${colors.reset} ${colors.bright}License ID:${colors.reset} ${colors.yellow}${l.id}${colors.reset}`);
    console.log(`    ${colors.dim}Customer:${colors.reset} ${l.customer_id}`);
    console.log(`    ${colors.dim}Subscription:${colors.reset} ${l.subscription_id}`);
    console.log(`    ${colors.dim}License Key:${colors.reset} ${colors.green}${l.license_key}${colors.reset}`);
    console.log(`    ${colors.dim}Status:${colors.reset} ${l.status === 'active' ? colors.green : colors.yellow}${l.status}${colors.reset}`);
    if (l.created_at) {
      const date = typeof l.created_at === 'number' ? new Date(l.created_at * 1000).toLocaleString() : l.created_at;
      console.log(`    ${colors.dim}Created:${colors.reset} ${date}`);
    }
  });
} else {
  console.log(colors.yellow + 'No licenses found' + colors.reset);
}

// Summary
console.log('\n\n' + colors.cyan + '='.repeat(80) + colors.reset);
console.log(colors.bright + colors.magenta + '📈 SUMMARY' + colors.reset);
console.log(colors.dim + '-'.repeat(80) + colors.reset);

const paymentCount = queryDB('SELECT COUNT(*) as count FROM payments');
const licenseCount = queryDB('SELECT COUNT(*) as count FROM licenses');
const activeLicenses = queryDB("SELECT COUNT(*) as count FROM licenses WHERE status = 'active'");

console.log(`${colors.bright}Total Payments:${colors.reset} ${colors.green}${paymentCount[0]?.count || 0}${colors.reset}`);
console.log(`${colors.bright}Total Licenses:${colors.reset} ${colors.green}${licenseCount[0]?.count || 0}${colors.reset}`);
console.log(`${colors.bright}Active Licenses:${colors.reset} ${colors.green}${activeLicenses[0]?.count || 0}${colors.reset}`);

console.log('\n' + colors.cyan + '='.repeat(80) + colors.reset + '\n');

