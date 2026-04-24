const axios = require('axios');
const cheerio = require('cheerio');

async function debugGTvsRCB() {
  try {
    console.log('=== DEBUGGING GT VS RCB SCRAPED TEXT ===');
    
    const BASE_URL = 'https://www.cricbuzz.com';
    const HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': BASE_URL,
    };
    
    const response = await axios.get(BASE_URL + '/cricket-match/live-scores', { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(response.data);
    
    $('.cb-lv-scrs-blk').each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      
      if (text.includes('Gujarat') && text.includes('Royal')) {
        console.log('Found GT vs RCB block:');
        console.log('Full text:', text);
        console.log('\nAnalyzing text:');
        console.log('- Length:', text.length);
        console.log('- Contains "live":', text.includes('live'));
        console.log('- Contains "batting":', text.includes('batting'));
        console.log('- Contains "bowling":', text.includes('bowling'));
        console.log('- Contains "running":', text.includes('running'));
        console.log('- Contains score pattern:', /\d+-\d+/.test(text));
        console.log('- Contains toss info:', /toss|opt to bat|opt to bowl/i.test(text));
        
        return false;
      }
    });
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

debugGTvsRCB();
