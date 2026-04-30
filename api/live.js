const axios = require('axios');
const { load } = require('cheerio');

const BASE_URL = 'https://www.cricbuzz.com';
const LIVE_URL = `${BASE_URL}/cricket-match/live-scores`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  Referer: BASE_URL,
};

const ABBR_TO_TEAM = {
  LSG: 'Lucknow Super Giants',
  RCB: 'Royal Challengers Bengaluru',
  MI: 'Mumbai Indians',
  PBKS: 'Punjab Kings',
  SRH: 'Sunrisers Hyderabad',
  KKR: 'Kolkata Knight Riders',
  RR: 'Rajasthan Royals',
  DC: 'Delhi Capitals',
  GT: 'Gujarat Titans',
  CSK: 'Chennai Super Kings',
};

function matchIdFromHref(href) {
  const m = String(href || '').match(/\/live-cricket-scores\/(\d+)\//);
  return m ? m[1] : null;
}

function getFullTeamName(abbr) {
  return ABBR_TO_TEAM[String(abbr || '').toUpperCase()] || abbr;
}

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redisGet(key) {
  const cfg = getRedisConfig();
  if (!cfg) return null;
  try {
    const res = await axios.get(`${cfg.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      timeout: 5000,
    });
    const raw = res.data && res.data.result;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function oversDecimalToDisplay(overDec) {
  const value = Number(overDec);
  if (!Number.isFinite(value) || value < 0) return null;
  const whole = Math.floor(value);
  const balls = Math.round((value - whole) * 6);
  if (balls >= 6) return `${whole + 1}.0`;
  return `${whole}.${balls}`;
}

function latestBallForInnings(balls, innings) {
  return balls
    .filter((b) => Number(b.innings) === innings)
    .sort((a, b) => {
      const oa = Number(a.over) || 0;
      const ob = Number(b.over) || 0;
      if (oa !== ob) return oa - ob;
      return (a.timestamp || '').localeCompare(b.timestamp || '');
    })
    .pop();
}

function parseScoreTuples(html) {
  const out = [];
  const seen = new Set();
  const re = /(\d{1,3})\/(\d{1,2})\s*\((\d{1,2}\.\d)\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const runs = Number(m[1]);
    const wickets = Number(m[2]);
    const overs = m[3];
    const key = `${runs}-${wickets}-${overs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ runs, wickets, overs });
    if (out.length >= 2) break;
  }
  return out;
}

function inferWinnerTeam(match) {
  const result = String(match?.result || '').toLowerCase();
  const teams = match?.teams || [];
  return teams.find((t) => result.includes(String(t).toLowerCase())) || null;
}

function teamAbbr(teamName) {
  const entry = Object.entries(ABBR_TO_TEAM).find(([, full]) => full === teamName);
  return entry ? entry[0] : null;
}

function parseScoresFromTitleHtml(html, teams) {
  const titleMatch = String(html).match(/<title>([^<]+)<\/title>/i);
  if (!titleMatch) return null;
  const title = titleMatch[1].replace(/\s+/g, ' ').trim();
  const vsIdx = title.indexOf(' vs ');
  if (vsIdx < 0) return null;
  const left = title.slice(0, vsIdx);
  const right = title.slice(vsIdx + 4);

  const re = /([A-Z]{2,5})\s+(\d{1,3})\/(\d{1,2})\s*\((\d{1,2}\.\d)\)/g;
  const chunks = [];
  let m;
  while ((m = re.exec(left + ' | ' + right)) !== null && chunks.length < 2) {
    chunks.push({ abbr: m[1], runs: Number(m[2]), wickets: Number(m[3]), overs: m[4] });
  }
  if (!chunks.length) return null;

  const team1Abbr = teamAbbr(teams?.[0] || '');
  const team2Abbr = teamAbbr(teams?.[1] || '');
  const innings1 = chunks.find((c) => c.abbr === team1Abbr) || null;
  const innings2 = chunks.find((c) => c.abbr === team2Abbr) || null;

  return {
    innings1: innings1 ? { team: teams?.[0] || 'Team 1', runs: innings1.runs, wickets: innings1.wickets, overs: innings1.overs } : null,
    innings2: innings2 ? { team: teams?.[1] || 'Team 2', runs: innings2.runs, wickets: innings2.wickets, overs: innings2.overs } : null,
  };
}

function extractEscapedObjectAfter(html, anchor, objectKey) {
  const anchorIdx = html.indexOf(anchor);
  if (anchorIdx < 0) return null;
  const keyIdx = html.indexOf(objectKey, anchorIdx);
  if (keyIdx < 0) return null;
  const braceStart = html.indexOf('{', keyIdx);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(braceStart, i + 1);
    }
  }
  return null;
}

function parseMatchScoreFromLiveScoresHtml(html, matchId, teams) {
  const blockStartKey = `\\"match\\":{\\"matchInfo\\":{\\"matchId\\":${matchId}`;
  const start = html.indexOf(blockStartKey);
  if (start < 0) return null;
  const next = html.indexOf('\\"match\\":{\\"matchInfo\\":{\\"matchId\\":', start + blockStartKey.length);
  const block = html.slice(start, next > start ? next : start + 4000);
  const team1Raw = extractEscapedObjectAfter(block, '\\"team1Score\\":', '\\"inngs1\\":');
  const team2Raw = extractEscapedObjectAfter(block, '\\"team2Score\\":', '\\"inngs1\\":');
  if (!team1Raw || !team2Raw) return null;
  let t1 = null;
  let t2 = null;
  try {
    t1 = JSON.parse(team1Raw.replace(/\\"/g, '"'));
    t2 = JSON.parse(team2Raw.replace(/\\"/g, '"'));
  } catch {
    return null;
  }
  return {
    innings1: { team: teams?.[0] || 'Team 1', runs: Number(t1.runs) || 0, wickets: Number(t1.wickets) || 0, overs: String(t1.overs ?? '') },
    innings2: { team: teams?.[1] || 'Team 2', runs: Number(t2.runs) || 0, wickets: Number(t2.wickets) || 0, overs: String(t2.overs ?? '') },
  };
}

async function fetchScoreFromMatchPage(matchId, slug, teams) {
  try {
    const url = `https://www.cricbuzz.com/live-cricket-scores/${matchId}/${slug}`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 10000 });
    const titleScores = parseScoresFromTitleHtml(res.data, teams);
    if (titleScores && (titleScores.innings1 || titleScores.innings2)) return titleScores;
    const tuples = parseScoreTuples(res.data);
    if (!tuples.length) return null;
    const innings1 = tuples[0]
      ? { team: teams?.[0] || 'Team 1', runs: tuples[0].runs, wickets: tuples[0].wickets, overs: tuples[0].overs }
      : null;
    const innings2 = tuples[1]
      ? { team: teams?.[1] || 'Team 2', runs: tuples[1].runs, wickets: tuples[1].wickets, overs: tuples[1].overs }
      : null;
    return { innings1, innings2 };
  } catch {
    return null;
  }
}

async function enrichMatchWithScore(match) {
  if (!match || !match.matchId || (match.status !== 'live' && match.status !== 'completed')) return match;

  // Source of truth for scoreboard display: Cricbuzz page payload.
  const pageScores = await fetchScoreFromMatchPage(match.matchId, match.slug, match.teams);
  if (pageScores && (pageScores.innings1 || pageScores.innings2)) {
    if (pageScores.innings1) match.innings1 = pageScores.innings1;
    if (pageScores.innings2) match.innings2 = pageScores.innings2;
  }

  const balls = await redisGet(`scorecard_${match.matchId}`);
  if ((!match.innings1 && !match.innings2) && Array.isArray(balls) && balls.length > 0) {
    const last1 = latestBallForInnings(balls, 1);
    const last2 = latestBallForInnings(balls, 2);

    if (last1) {
      match.innings1 = {
        team: match.teams?.[0] || 'Team 1',
        runs: Number(last1.runs) || 0,
        wickets: Number(last1.wickets) || 0,
        overs: oversDecimalToDisplay(last1.over),
      };
    }
    if (last2) {
      match.innings2 = {
        team: match.teams?.[1] || 'Team 2',
        runs: Number(last2.runs) || 0,
        wickets: Number(last2.wickets) || 0,
        overs: oversDecimalToDisplay(last2.over > 20 ? last2.over - 20 : last2.over),
      };
    }
  }

  // Fallback when Redis scorecard is unavailable/outdated.
  if (!match.innings1 && !match.innings2) {
    // Last resort: keep current null innings (upcoming-like display).
  }

  // If only one innings score is available for a completed game, attach it to winner side.
  if (match.status === 'completed' && match.innings1 && !match.innings2) {
    const winner = inferWinnerTeam(match);
    if (winner && match.teams && winner === match.teams[1]) {
      match.innings2 = { ...match.innings1, team: match.teams[1] };
      match.innings1 = null;
    } else if (winner && match.teams && winner === match.teams[0]) {
      match.innings1 = { ...match.innings1, team: match.teams[0] };
    }
  }

  const active = match.innings2 || match.innings1;
  if (active) {
    match.score = {
      runs: active.runs,
      wickets: active.wickets,
      overs_decimal: Number(active.overs),
      overs_input: active.overs,
    };
  }
  return match;
}

async function getLiveMatchesData() {
  const response = await axios.get(LIVE_URL, { headers: HEADERS, timeout: 10000 });
  const pageHtml = response.data;
  const $ = load(pageHtml);

  const matches = [];
  const seenIds = new Set();

  $('a[href*="/live-cricket-scores/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    const matchId = matchIdFromHref(href);
    if (!matchId || seenIds.has(matchId)) return;

    const hrefLower = href.toLowerCase();
    const isIpl = hrefLower.includes('ipl') || Object.keys(ABBR_TO_TEAM).some((abbr) => new RegExp(`\\b${abbr.toLowerCase()}\\b`).test(hrefLower));
    if (!isIpl) return;

    const vsMatch = text.match(/([A-Z]{2,5})\s+vs\s+([A-Z]{2,5})/);
    if (!vsMatch) return;
    const team1 = ABBR_TO_TEAM[vsMatch[1]];
    const team2 = ABBR_TO_TEAM[vsMatch[2]];
    if (!team1 || !team2) return;

    let status = 'upcoming';
    let result = 'Upcoming';
    const isCompleted = /won by|completed|final| \w+ won/i.test(text);
    const isLive = !isCompleted && /opt to bat|opt to bowl|toss|live|batting|bowling|running/i.test(text);

    if (isCompleted) {
      status = 'completed';
      const winnerMatch = text.match(/(\w+) won/i);
      if (winnerMatch) {
        result = `${getFullTeamName(winnerMatch[1])} won`;
      } else {
        result = 'Match completed';
      }
    } else if (isLive) {
      status = 'live';
      result = 'In progress';
    }

    matches.push({
      matchId,
      slug: href.split('/live-cricket-scores/')[1]?.split('/')[1] || '',
      teams: [team1, team2],
      score: { runs: null, wickets: null, overs_decimal: null, overs_input: null },
      status,
      series: 'IPL',
      result,
      scraped_at: new Date().toISOString(),
      innings1: null,
      innings2: null,
      href,
    });

    const scoreFromList = (status === 'live' || status === 'completed')
      ? parseMatchScoreFromLiveScoresHtml(pageHtml, matchId, [team1, team2])
      : null;
    if (scoreFromList) {
      matches[matches.length - 1].innings1 = scoreFromList.innings1;
      matches[matches.length - 1].innings2 = scoreFromList.innings2;
      const active = scoreFromList.innings2 || scoreFromList.innings1;
      if (active) {
        matches[matches.length - 1].score = {
          runs: active.runs,
          wickets: active.wickets,
          overs_decimal: Number(active.overs),
          overs_input: active.overs,
        };
      }
    }

    seenIds.add(matchId);
    if (matches.length >= 6) return false;
  });

  const hydrated = await Promise.all(matches.map(enrichMatchWithScore));
  return { matches: hydrated };
}

async function handler(req, res) {
  try {
    const data = await getLiveMatchesData();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[live] error:', err.message);
    return res.status(500).json({ error: err.message, matches: [] });
  }
}

module.exports = handler;
module.exports.getLiveMatchesData = getLiveMatchesData;
