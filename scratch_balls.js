const axios = require('axios');
const HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36', 'Referer': 'https://www.cricbuzz.com'};

// Use the current live match
axios.get('https://www.cricbuzz.com/live-cricket-over-by-over/151840/pbks-vs-lsg-29th-match-indian-premier-league-2026', {headers: HEADERS, timeout: 15000})
  .then(r => {
    const text = r.data;
    const gridIdx = text.indexOf('Overs</div>');
    if (gridIdx < 0) { console.log('no grid'); return; }
    const section = text.slice(gridIdx, gridIdx + 60000);
    const plain = section.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const lines = plain.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    // Print first 120 lines to see ball structure
    lines.slice(0, 120).forEach((l, i) => process.stdout.write(i + ': ' + l + '\n'));
  })
  .catch(e => console.error(e.message));
