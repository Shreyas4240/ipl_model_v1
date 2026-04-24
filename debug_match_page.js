const axios = require('axios');
const cheerio = require('cheerio');

async function debugMatchPage() {
  try {
    console.log('=== DEBUGGING GT vs RCB MATCH PAGE ===');
    
    const BASE_URL = 'https://www.cricbuzz.com';
    const HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': BASE_URL,
    };
    
    const matchId = '151889';
    const matchUrl = `${BASE_URL}/live-cricket-scores/151889/gt-vs-rcb-34th-match-ipl-2026`;
    
    console.log('Fetching:', matchUrl);
    const response = await axios.get(matchUrl, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(response.data);
    
    console.log('Page title:', $('title').text());
    
    // Look for various score selectors
    const selectors = [
      '.cb-scr-wll-hdr',
      '.cb-scr-hdr',
      '.cb-scr-hdr-cnt',
      '.cb-scr-crd-hdr',
      '.cb-scr-tbl',
      '.cb-scr-itm',
      '.cb-col',
      '.cb-text'
    ];
    
    console.log('\nChecking score selectors:');
    selectors.forEach(selector => {
      const text = $(selector).first().text();
      if (text) {
        console.log(`${selector}: "${text}"`);
        
        // Check for score pattern
        const scoreMatch = text.match(/(\d+)(?:-(\d+))?\s*\(([\d.]+)\)/);
        if (scoreMatch) {
          console.log(`  ^^^ SCORE FOUND: ${scoreMatch[1]}-${scoreMatch[2] || '10'} (${scoreMatch[3]})`);
        }
      }
    });
    
    // Look for anything that looks like a score
    console.log('\nLooking for score patterns in page text:');
    const bodyText = $('body').text();
    const scorePatterns = bodyText.match(/(\d+)(?:-(\d+))?\s*\(([\d.]+)\)/g);
    
    if (scorePatterns) {
      console.log('Found score patterns:', scorePatterns.slice(0, 5));
    } else {
      console.log('No score patterns found');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

debugMatchPage();
