const axios = require('axios');
const cheerio = require('cheerio');
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' };
async function test() {
  const r = await axios.get('https://www.cricbuzz.com/cricket-match/live-scores', { headers: HEADERS });
  const $ = cheerio.load(r.data);
  $('a[href*="/live-cricket-scores/"]').each((i, el) => {
    console.log('--- LINK ' + i + ' ---');
    console.log('HREF:', $(el).attr('href'));
    console.log('TEXT:', $(el).text().trim());
  });
}
test();
