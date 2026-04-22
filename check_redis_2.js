const axios = require('axios');
const fs = require('fs');

const env = fs.readFileSync('.env', 'utf-8');
const urlMatch = env.match(/KV_REST_API_URL="?([^"\n]+)/);
const tokenMatch = env.match(/KV_REST_API_TOKEN="?([^"\n]+)/);
const url = urlMatch ? urlMatch[1] : null;
const token = tokenMatch ? tokenMatch[1] : null;

async function main() {
  const key = 'match_history_v2_151867';
  const res = await axios.get(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = JSON.parse(res.data.result || '[]');
  console.log(data.slice(0, 5));
}
main().catch(console.error);
