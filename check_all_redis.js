const axios = require('axios');
const fs = require('fs');

const env = fs.readFileSync('.env', 'utf-8');
const urlMatch = env.match(/KV_REST_API_URL="?([^"\n]+)/);
const tokenMatch = env.match(/KV_REST_API_TOKEN="?([^"\n]+)/);
const url = urlMatch ? urlMatch[1] : null;
const token = tokenMatch ? tokenMatch[1] : null;

async function main() {
  const res = await axios.get(`${url}/scan/0?match=match_history_v2_*`, { headers: { Authorization: `Bearer ${token}` } });
  console.log("Keys found:", res.data.result[1]);
}
main().catch(console.error);
