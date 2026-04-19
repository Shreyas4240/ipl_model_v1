const axios = require('axios');
const { load } = require('cheerio');

const BASE_URL = 'https://www.cricbuzz.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
  'Referer': BASE_URL,
};

function parseOverByOver(html) {
  const gridIdx = html.indexOf('Overs</div>');
  if (gridIdx < 0) return { innings: [] };

  const section = html.slice(gridIdx, gridIdx + 60000);
  const plain = section.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lines = plain.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const overData = [];
  let i = 0;
  while (i < lines.length) {
    const ovMatch = lines[i].match(/^Ov\s+(\d+)$/);
    if (ovMatch) {
      const overNum = parseInt(ovMatch[1]);
      if (i + 1 < lines.length) {
        const scoreMatch = lines[i + 1].match(/^(\d+)-(\d+)$/);
        if (scoreMatch) {
          overData.push({ over: overNum, startRuns: parseInt(scoreMatch[1]), startWickets: parseInt(scoreMatch[2]) });
          i += 2; continue;
        }
      }
    }
    i++;
  }

  if (!overData.length) return { innings: [] };
  overData.sort((a, b) => a.over - b.over);

  const innings = [];
  let cur = [];
  for (let j = 0; j < overData.length; j++) {
    const o = overData[j];
    const prev = cur[cur.length - 1];
    if (prev && (o.over < prev.over || o.startRuns < prev.startRuns - 5)) {
      innings.push(cur); cur = [];
    }
    cur.push(o);
  }
  if (cur.length) innings.push(cur);

  return {
    innings: innings.map(inn => {
      return inn.map((o, j) => {
        const next = inn[j + 1];
        return { over: o.over, runs: next ? next.startRuns : o.startRuns, wickets: next ? next.startWickets : o.startWickets };
      });
    })
  };
}

axios.get('https://www.cricbuzz.com/live-cricket-over-by-over/151818/srh-vs-csk-27th-match-indian-premier-league-2026', { headers: HEADERS, timeout: 15000 })
  .then(r => {
    const result = parseOverByOver(r.data);
    result.innings.forEach((inn, i) => {
      console.log(`\nInnings ${i + 1} (${inn.length} overs):`);
      inn.forEach(p => process.stdout.write(`  Ov${p.over}: ${p.runs}/${p.wickets}\n`));
    });
  })
  .catch(e => console.error(e.message));
