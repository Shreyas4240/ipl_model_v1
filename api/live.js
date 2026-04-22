const axios = require('axios');
const { load } = require('cheerio');

const BASE_URL = 'https://www.cricbuzz.com';
const LIVE_URL = `${BASE_URL}/cricket-match/live-scores`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Referer': BASE_URL,
};

const ABBR_TO_TEAM = {
  'LSG':  'Lucknow Super Giants',
  'RCB':  'Royal Challengers Bengaluru',
  'MI':   'Mumbai Indians',
  'PBKS': 'Punjab Kings',
  'CSK':  'Chennai Super Kings',
  'KKR':  'Kolkata Knight Riders',
  'RR':   'Rajasthan Royals',
  'DC':   'Delhi Capitals',
  'SRH':  'Sunrisers Hyderabad',
  'GT':   'Gujarat Titans',
};

const IPL_TEAMS = new Set(Object.values(ABBR_TO_TEAM));

function matchIdFromHref(href) {
  const m = href.match(/\/live-cricket-scores\/(\d+)\//);
  return m ? m[1] : null;
}

/**
 * Extract venue from the rich card text.
 * Format: "Nth Match • City, Stadium Name TEAM1..."
 * Returns the "City, Stadium Name" portion.
 */
function parseVenue(text) {
  // Match text between bullet point and first uppercase team word
  const m = text.match(/Match\s*[•·]\s*(.+?)(?=[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:SRH|CSK|MI|RCB|DC|KKR|RR|GT|PBKS|LSG))/);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  // Fallback: grab text after bullet up to first known abbr
  const bullet = text.match(/[•·]\s*([^•·]+)/);
  if (bullet) return bullet[1].trim().split(/[A-Z]{2,4}/)[0].trim();
  return '';
}

/**
 * Parse a rich scorecard link text from the listing page.
 * Examples:
 *   '27th Match • Hyderabad...SRH29-0 (3.2)...CSK opt to bowl'
 *   '26th Match • Bengaluru...RCB175-8 (20)DC179-4 (19.5)Delhi Capitals won by 6 wkts'
 * Cricbuzz uses RUNS-WICKETS (OVERS) format (hyphen, not slash).
 */
function parseRichCard(text) {
  // Find all IPL abbreviations in order of appearance
  const abbrPositions = [];
  for (const abbr of Object.keys(ABBR_TO_TEAM)) {
    const pos = text.indexOf(abbr);
    if (pos >= 0) abbrPositions.push({ pos, abbr });
  }
  abbrPositions.sort((a, b) => a.pos - b.pos);

  if (abbrPositions.length < 2) return null;

  const abbr1 = abbrPositions[0].abbr;
  const abbr2 = abbrPositions[1].abbr;
  const pos1  = abbrPositions[0].pos;
  const pos2  = abbrPositions[1].pos;

  // Score pattern: RUNS-WICKETS (OVERS) or RUNS (OVERS) for all out  e.g. "29-0 (3.2)", "175-8 (20)", or "119 (18.4)"
  const scoreRe = /(\d+)(?:-(\d+))?\s*\(([\d.]+)\)/g;

  // Scores in the segment after abbr1 up to abbr2
  const seg1 = text.slice(pos1, pos2);
  const seg2 = text.slice(pos2);

  const m1 = scoreRe.exec(seg1);
  scoreRe.lastIndex = 0;
  const m2 = scoreRe.exec(seg2);

  const inn1 = m1 ? {
    team: ABBR_TO_TEAM[abbr1],
    runs: parseInt(m1[1]),
    wickets: m1[2] ? parseInt(m1[2]) : 10,
    overs: m1[3],
  } : null;

  const inn2 = m2 ? {
    team: ABBR_TO_TEAM[abbr2],
    runs: parseInt(m2[1]),
    wickets: m2[2] ? parseInt(m2[2]) : 10,
    overs: m2[3],
  } : null;

  // Status
  const tl = text.toLowerCase();
  let status, result;

  if (/won\s+by/i.test(text)) {
    status = 'completed';
    // Extract result using known team names
    const teamNames = Object.values(ABBR_TO_TEAM)
      .sort((a, b) => b.length - a.length)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const rm = text.match(new RegExp(`(${teamNames})\\s+won\\s+by\\s+(\\d+)\\s+(wkts?|wickets?|runs?)`, 'i'));
    result = rm ? `${rm[1]} won by ${rm[2]} ${/^wkt|^wic/i.test(rm[3]) ? 'wickets' : 'runs'}` : 'Match completed';
  } else if (inn1 || /opt to bat|opt to bowl|toss/i.test(text)) {
    status = 'live';
    result = 'In progress';
  } else if (/preview/i.test(text)) {
    status = 'upcoming';
    result = 'Upcoming';
  } else {
    status = 'upcoming';
    result = 'Upcoming';
  }

  // Legacy score field for predictor (currently batting innings)
  const predInn = inn2 || inn1;
  const score = predInn ? {
    runs: predInn.runs,
    wickets: predInn.wickets,
    overs_decimal: predInn.overs,
    overs_input: predInn.overs,
  } : { runs: null, wickets: null, overs_decimal: null, overs_input: null };

  return {
    teams: [ABBR_TO_TEAM[abbr1], ABBR_TO_TEAM[abbr2]],
    innings1: inn1,
    innings2: inn2,
    score,
    status,
    series: 'IPL 2026',
    result,
    venue: parseVenue(text),
    scraped_at: new Date().toISOString(),
  };
}

async function getLiveMatchesData() {
  console.log(`[live] called at ${new Date().toISOString()}`);
  try {
    const listResp = await axios.get(LIVE_URL, { headers: HEADERS, timeout: 15000 });
    const $ = load(listResp.data);

    const seenIds = new Set();
    const matches = [];

    // The listing page has two types of IPL links per match:
    //   1. Short status link: "SRH vs CSK - CSK opt to bowl"  (no score)
    //   2. Rich scorecard link: "27th Match • ...SRH29-0 (3.2)...CSK..."  (has score)
    // We want the rich scorecard links (len > 80 chars) — they have everything.
    // Fall back to short links for upcoming matches that have no scorecard yet.

    const shortLinks = {};  // matchId → { href, text }

    // Collect all links first, then process them
    const allLinks = [];
    $('a[href*="/live-cricket-scores/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      const matchId = matchIdFromHref(href);
      if (!matchId) return;

      const hrefLower = href.toLowerCase();
      const isIpl = hrefLower.includes('ipl') ||
        Object.keys(ABBR_TO_TEAM).some(abbr =>
          new RegExp(`\\b${abbr.toLowerCase()}\\b`).test(hrefLower)
        );
      if (!isIpl) return;

      allLinks.push({ href, text, matchId });
    });

    // Process links with async support for live matches
    for (const { href, text, matchId } of allLinks) {
      if (text.length > 80) {
        // Rich scorecard — parse directly
        if (seenIds.has(matchId)) continue;
        const parsed = parseRichCard(text);
        if (!parsed) continue;
        if (!IPL_TEAMS.has(parsed.teams[0]) && !IPL_TEAMS.has(parsed.teams[1])) continue;

        // Add matchId and slug so frontend can call /api/scorecard
        parsed.matchId = matchId;
        // slug = just the text part after the matchId, e.g. "pbks-vs-lsg-29th-match-..."
        console.log('[live.js] Processing href:', href, 'matchId:', matchId);
        const hrefParts = href.split('/live-cricket-scores/')[1] || '';
        console.log('[live.js] hrefParts after split:', hrefParts);
        parsed.slug = hrefParts.includes('/') ? hrefParts.split('/').slice(1).join('/') : hrefParts;
        console.log('[live.js] Generated slug:', parsed.slug);
        seenIds.add(matchId);
        matches.push(parsed);
      } else {
        // Short link — store as fallback for upcoming matches
        if (!shortLinks[matchId]) shortLinks[matchId] = { href, text };
      }
    }

    // Add upcoming matches that only appeared as short links (no rich card)
    for (const [matchId, { text }] of Object.entries(shortLinks)) {
      if (seenIds.has(matchId)) continue;
      if (matches.length >= 3) break;

      // Parse team names from short link: "KKR vs RR - Preview"
      const vsMatch = text.match(/([A-Z]{2,5})\s+vs\s+([A-Z]{2,5})/);
      if (!vsMatch) continue;
      const team1 = ABBR_TO_TEAM[vsMatch[1]];
      const team2 = ABBR_TO_TEAM[vsMatch[2]];
      if (!team1 || !team2) continue;

      seenIds.add(matchId);
      matches.push({
        teams: [team1, team2],
        innings1: null,
        innings2: null,
        score: { runs: null, wickets: null, overs_decimal: null, overs_input: null },
        status: 'upcoming',
        series: 'IPL 2026',
        result: 'Upcoming',
        scraped_at: new Date().toISOString(),
      });
    }

    console.log(`[live] returning ${matches.length} matches`);
    return { matches: matches.slice(0, 3) };

  } catch (err) {
    console.error('[live] error:', err.message);
    throw err;
  }
}

async function handler(req, res) {
  try {
    const data = await getLiveMatchesData();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message, matches: [] });
  }
}

module.exports = handler;
module.exports.getLiveMatchesData = getLiveMatchesData;
