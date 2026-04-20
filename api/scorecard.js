const axios = require('axios');

const BASE_URL = 'https://www.cricbuzz.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': BASE_URL,
};

/**
 * Parse the over-by-over page into ball-by-ball snapshots.
 *
 * Page structure (overs in reverse order, newest first):
 *   "Ov N"           ← over number (1-indexed)
 *   "RUNS-WICKETS"   ← cumulative score at START of this over
 *   "Bowler to Bat"  ← description (skip)
 *   ball values...   ← "•" "1" "4" "6" "W" "Wd" "Nb" "L1" "B1" etc.
 *   total_runs       ← last number = runs scored in the over (skip)
 *
 * Ball value rules:
 *   "•"        = dot ball (0 runs, legal)
 *   digit      = runs scored (legal)
 *   "W"        = wicket (0 runs, legal)
 *   "Wd"       = wide (1 run, NOT legal)
 *   "Nb"       = no-ball (1 run, NOT legal)
 *   "L1","L2"  = leg bye (legal delivery)
 *   "B1","B2"  = bye (legal delivery)
 *   last item before next "Ov" = over total (skip)
 */
function parseBallByBall(html, currentInnings = 1) {
  const gridIdx = html.indexOf('Overs</div>');
  if (gridIdx < 0) return [];

  const section = html.slice(gridIdx, gridIdx + 80000);
  const plain = section.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lines = plain.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Parse over blocks
  const overBlocks = []; // [{overNum, startRuns, startWickets, balls: []}]
  let i = 0;
  while (i < lines.length) {
    const ovMatch = lines[i].match(/^Ov\s+(\d+)$/);
    if (ovMatch) {
      const overNum = parseInt(ovMatch[1]);
      if (i + 1 < lines.length) {
        const scoreMatch = lines[i + 1].match(/^(\d+)-(\d+)$/);
        if (scoreMatch) {
          // Collect ball values until next "Ov N" or end
          const balls = [];
          let j = i + 3; // skip score line and bowler/batter line
          while (j < lines.length && !lines[j].match(/^Ov\s+\d+$/) && !lines[j].match(/^FEATURED/)) {
            balls.push(lines[j]);
            j++;
          }
          overBlocks.push({
            overNum,
            startRuns: parseInt(scoreMatch[1]),
            startWickets: parseInt(scoreMatch[2]),
            balls,
          });
          i = j;
          continue;
        }
      }
    }
    i++;
  }

  if (!overBlocks.length) return [];

  // The HTML source lists blocks in reverse chronological order (newest first).
  // Reverse the array to get true chronological sequence across all innings.
  overBlocks.reverse();

  // Detect innings boundary (over resets or score drops)
  const innings = [];
  let curInnings = [];
  for (let k = 0; k < overBlocks.length; k++) {
    const blk = overBlocks[k];
    const prev = curInnings[curInnings.length - 1];
    if (prev && (blk.overNum < prev.overNum || blk.startRuns < prev.startRuns - 5)) {
      innings.push(curInnings);
      curInnings = [];
    }
    curInnings.push(blk);
  }
  if (curInnings.length) innings.push(curInnings);

  // Build ball-by-ball snapshots for each innings
  const result = [];

  const startInnIdx = (innings.length === 1 && String(currentInnings) === '2') ? 1 : 0;

  innings.forEach((inn, idx) => {
    const innIdx = startInnIdx + idx;
    let cumRuns = 0;
    let cumWickets = 0;
    let ballSeq = 0; // global ball counter for this innings

    inn.forEach(blk => {
      // Set state to start of this over
      cumRuns = blk.startRuns;
      cumWickets = blk.startWickets;

      const overNum = blk.overNum;
      let legalInOver = 0;
      const rawBalls = blk.balls;

      // The last item in balls is the over total (a plain number) — skip it
      // Detect: last item is a number and equals sum of legal ball runs
      // Simpler: just skip the last item if it's a plain integer
      const ballItems = rawBalls[rawBalls.length - 1] && rawBalls[rawBalls.length - 1].match(/^\d+$/)
        ? rawBalls.slice(0, -1)
        : rawBalls;

      for (const ball of ballItems) {
        const isWide  = /^Wd/i.test(ball);
        const isNoBall = /^Nb/i.test(ball);
        const isWicket = ball === 'W';
        const isDot   = ball === '•';
        const legBye  = ball.match(/^L(\d+)$/);
        const bye     = ball.match(/^B(\d+)$/);
        const runs    = ball.match(/^(\d+)$/);

        let runsScored = 0;
        let isLegal = true;

        if (isWide) {
          runsScored = 1;
          isLegal = false;
        } else if (isNoBall) {
          runsScored = 1;
          isLegal = false;
        } else if (isWicket) {
          runsScored = 0;
          cumWickets++;
          isLegal = true;
        } else if (isDot) {
          runsScored = 0;
          isLegal = true;
        } else if (legBye) {
          runsScored = parseInt(legBye[1]);
          isLegal = true;
        } else if (bye) {
          runsScored = parseInt(bye[1]);
          isLegal = true;
        } else if (runs) {
          runsScored = parseInt(runs[1]);
          isLegal = true;
        } else {
          // Unknown token — skip
          continue;
        }

        cumRuns += runsScored;
        if (isLegal) legalInOver++;

        ballSeq++;
        const overDecimal = (overNum - 1) + legalInOver / 6;

        result.push({
          innings: innIdx + 1,
          ball: ballSeq,
          over: parseFloat(overDecimal.toFixed(4)),
          overLabel: (overNum - 1) + '.' + legalInOver,
          runs: cumRuns,
          wickets: cumWickets,
        });
      }
    });
  });

  return result;
}

async function fetchAndMergeScorecard(matchId, slug, currentInnings) {
  const url = `${BASE_URL}/live-cricket-over-by-over/${matchId}/${slug}`;
  let scrapedBalls = [];
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    scrapedBalls = parseBallByBall(resp.data, currentInnings);
  } catch (err) {
    console.error('[scorecard] fetch error:', err.message);
  }

  const restUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!restUrl || !restToken) {
     console.log("[scorecard] No Redis REST credentials found, falling back to scraped");
     return scrapedBalls;
  }

  let existingBalls = [];
  try {
    const res = await axios.post(restUrl, ["GET", `match_history_${matchId}`], {
      headers: { Authorization: `Bearer ${restToken}` }
    });
    if (res.data && res.data.result) {
       let raw = res.data.result;
       if (typeof raw === 'string') raw = JSON.parse(raw);
       existingBalls = Array.isArray(raw) ? raw : [];
    }
  } catch (e) {
    console.error('[KV GET error]', e.message);
  }

  // Merge resolving any overlap by rewriting with chronological precision
  const mergedMap = new Map();
  [...existingBalls, ...scrapedBalls].forEach(b => {
     const key = `${b.innings}_${b.over.toFixed(4)}`;
     mergedMap.set(key, b);
  });

  const finalBalls = Array.from(mergedMap.values()).sort((a, b) => {
     if (a.innings !== b.innings) return a.innings - b.innings;
     return a.over - b.over;
  });

  let bSeq1 = 1;
  let bSeq2 = 1;
  finalBalls.forEach(b => {
     if (b.innings === 1) b.ball = bSeq1++;
     if (b.innings === 2) b.ball = bSeq2++;
  });

  if (finalBalls.length > 0) {
    try {
      await axios.post(restUrl, ["SET", `match_history_${matchId}`, JSON.stringify(finalBalls)], {
        headers: { Authorization: `Bearer ${restToken}` }
      });
    } catch (e) {
      console.error('[KV SET error]', e.message);
    }
  }

  return finalBalls;
}

module.exports = async function handler(req, res) {
  const matchId = req.query.matchId;
  const slug    = req.query.slug;
  const currentInnings = req.query.currentInnings || 1;

  if (!matchId || !slug) {
    return res.status(400).json({ error: 'matchId and slug required', balls: [] });
  }

  try {
    const balls = await fetchAndMergeScorecard(matchId, slug, currentInnings);
    return res.status(200).json({ matchId, slug, balls });
  } catch (err) {
    console.error('[scorecard] Error in handler:', err.message);
    return res.status(500).json({ error: err.message, balls: [] });
  }
};

module.exports.fetchAndMergeScorecard = fetchAndMergeScorecard;
