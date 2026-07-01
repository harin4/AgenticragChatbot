/**
 * scripts/init-db.js
 * Run ONCE to create tables in your Neon database via the Cloudflare Worker.
 *
 * Usage:
 *   export API_URL="http://127.0.0.1:8787"
 *   node scripts/init-db.js
 */

const API_URL = process.env.API_URL || 'http://127.0.0.1:8787';

async function init() {
  console.log('🔧  Sending init request to Cloudflare Worker...\n');

  try {
    const res = await fetch(`${API_URL}/init`, { 
      method: 'POST',
      headers: process.env.API_KEY ? { 'Authorization': `Bearer ${process.env.API_KEY}` } : {}
    });
    if (!res.ok) {
      console.error(`❌  Failed to initialize: ${res.statusText}`);
      process.exit(1);
    }
    const data = await res.json();
    if (data.error) {
      console.error(`❌  API Error: ${data.error}`);
      process.exit(1);
    }
    console.log('✅  Database initialized successfully via application layer!');
    console.log(data);
  } catch (err) {
    console.error(`❌  Network Error: ${err.message}`);
    console.error('    Is the Cloudflare Worker running? (npx wrangler dev)');
    process.exit(1);
  }
}

init();