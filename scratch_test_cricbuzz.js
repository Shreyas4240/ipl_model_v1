import axios from 'axios';
import { load } from 'cheerio';

async function test() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36'
  };
  const { data } = await axios.get('https://www.cricbuzz.com/cricket-match/live-scores', { headers });
  const $ = load(data);
  const links = $('a[href*="/live-cricket-scores/"]');
  for (let i = 0; i < 5; i++) {
     const href = links.eq(i).attr('href');
     if (!href) continue;
     const title = links.eq(i).text();
     console.log("MATCH:", title);
     
     try {
       const sub = await axios.get('https://www.cricbuzz.com' + href, { headers });
       const sub$ = load(sub.data);
       console.log("  .cb-text-complete length:", sub$('.cb-text-complete').length);
       console.log("  .cb-text-preview length:", sub$('.cb-text-preview').length);
       console.log("  .cb-text-live length:", sub$('.cb-text-live').length);
       console.log("  Text complete value:", sub$('.cb-text-complete').text());
     } catch(e) {
       console.log("  Error fetching");
     }
  }
}
test();
