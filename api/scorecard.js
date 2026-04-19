const axios = require('axios');
const { load } = require('cheerio');

const BASE_URL = 'https://www.cricbuzz.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': BASE_URL,
};

/**
 * Parse the over-by-over page into a list of { over, runs, wickets } points.
 *
 * Page structure (overs in reverse order, newest first):
 *   "Ov 14"          ← over number
 *   "147-5"          ← cumulative score at START of this over (runs-wickets)
 *   "Bowler to Bat"  ← description line (skip)
 *   "1" "4" "W" ...  ← individual ball values (skip)
 *   "8"              ← total runs in this over (skip — we use cumulative)
 *
 * We collect { over: N, runs: R, wickets: W } for each completed over,
 * then sort ascending and compute end-of-over score by adding the over's runs.
 */
function parseOverByOver(html) {
  const $ = load(html);

  // Strip all HTML to plain text lines, same as the working scratch script
  const gridIdx = html.indexOf('Overs</div>');
  if (gridIdx < 0) return { innings: [] };

  const section = html.slice(gridIdx, gridIdx + 60000);
  const plain = section.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lines = plain.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Parse innings blocks — a new innings starts when we see "Ov 1" after having seen higher overs
  // Each over block: "Ov N", "RUNS-WICKETS", description, balls..., total
  const overData = []; // { over, startRuns, startWickets }

  let i = 0;
  while (i < lines.length) {
    const ovMatch = lines[i].match(/^Ov\s+(\d+)$/);
    if (ovMatch) {
      const overNum = parseInt(ovMatch[1]);
      // Next line should be RUNS-WICKETS
      if (i + 1 < lines.length) {
        const scoreMatch = lines[i + 1].match(/^(\d+)-(\d+)$/);
        if (scoreMatch) {
          overData.push({
            over: overNum,
            startRuns: parseInt(scoreMatch[1]),
            startWickets: parseInt(scoreMatch[2]),
          });
          i += 2;
          continue;
        }
      }
    }
    i++;
  }

  if (!overData.length) return { innings: [] };

  // Sort ascending by over number
  overData.sort((a, b) => a.over - b.over);

  // Detect innings boundaries: if over number resets (Ov 1 appears after Ov 20, or score resets)
  const innings = [];
  let currentInnings = [];

  for (let j = 0; j < overData.length; j++) {
    const cur = overData[j];
    const prev = currentInnings[currentInnings.length - 1];

    // New innings if: over number goes back to 1 after being higher, or score drops significantly
    if (prev && (cur.over < prev.over || cur.startRuns < prev.startRuns - 5)) {
      innings.push(currentInnings);
      currentInnings = [];
    }
    currentInnings.push(cur);
  }
  if (currentInnings.length) innings.push(currentInnings);

  // For each innings, compute end-of-over score:
  // startRuns of over N+1 = endRuns of over N
  // For the last over, we don't have the next over's start, so we use startRuns as a floor
  const result = innings.map((inn, innIdx) => {
    const points = [];
    for (let j = 0; j < inn.length; j++) {
      const cur = inn[j];
      const next = inn[j + 1];
      // End-of-over score = start of next over (most accurate)
      // If no next over, use current start (the over is still in progress)
      const endRuns = next ? next.startRuns : cur.startRuns;
      const endWickets = next ? next.startWickets : cur.startWickets;
      points.push({
        over: cur.over,
        runs: endRuns,
        wickets: endWickets,
      });
    }
    return points;
  });

  return { innings: result };
}

module.exports = async function handler(req, res) {
  // Expect ?matchId=151818&slug=srh-vs-csk-27th-match-indian-premier-league-2026
  const matchId = req.query.matchId;
  const slug = req.query.slug;

  if (!matchId || !slug) {
    return res.status(400).json({ error: 'matchId and slug required', innings: [] });
  }

  const url = `${BASE_URL}/live-cricket-over-by-over/${matchId}/${slug}`;
  console.log(`[scorecard] fetching ${url}`);

  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const parsed = parseOverByOver(resp.data);

    return res.status(200).json({
      matchId,
      slug,
      innings: parsed.innings,
    });
  } catch (err) {
    console.error('[scorecard] error:', err.message);
    return res.status(500).json({ error: err.message, innings: [] });
  }
};
