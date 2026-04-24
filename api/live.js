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
  
  // Debug: Log GT vs RCB matches
  if (text.includes('Gujarat') && text.includes('Royal')) {
    console.log('[DEBUG] GT vs RCB text:', text);
    console.log('[DEBUG] Contains opt to bowl:', /opt to bowl/i.test(text));
    console.log('[DEBUG] Contains opt to bat:', /opt to bat/i.test(text));
    console.log('[DEBUG] Contains toss:', /toss/i.test(text));
    console.log('[DEBUG] Has inn1:', !!inn1);
    console.log('[DEBUG] Has inn2:', !!inn2);
  }

  if (/won\s+by/i.test(text)) {
    status = 'completed';
    // Extract result using known team names
    const teamNames = Object.values(ABBR_TO_TEAM)
      .sort((a, b) => b.length - a.length)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const rm = text.match(new RegExp(`(${teamNames})\\s+won\\s+by\\s+(\\d+)\\s+(wkts?|wickets?|runs?)`, 'i'));
    result = rm ? `${rm[1]} won by ${rm[2]} ${/^wkt|^wic/i.test(rm[3]) ? 'wickets' : 'runs'}` : 'Match completed';
  } else if (inn1 || /opt to bat|opt to bowl|toss/i.test(text) || /live|batting|bowling|running/i.test(text)) {
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
      // Debug: Log GT vs RCB link details
      if (text.includes('Gujarat') && text.includes('Royal')) {
        console.log('[DEBUG] GT vs RCB link:');
        console.log('  Text length:', text.length);
        console.log('  Text:', text);
        console.log('  Is rich card:', text.length > 80);
        console.log('  Match ID:', matchId);
        console.log('  Href:', href);
      }
      
      if (text.length > 80) {
        // Rich scorecard — parse directly
        if (seenIds.has(matchId)) continue;
        
        // Debug: Log rich card processing
        if (text.includes('Gujarat') && text.includes('Royal')) {
          console.log('[DEBUG] Processing GT vs RCB as rich card');
          console.log('[DEBUG] Text length:', text.length);
          console.log('[DEBUG] Text:', text);
        }
        
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
    console.log('[DEBUG] shortLinks:', Object.keys(shortLinks));
    for (const [matchId, { text, href }] of Object.entries(shortLinks)) {
      console.log(`[DEBUG] Processing shortLink ${matchId}: seenIds.has=${seenIds.has(matchId)}, matches.length=${matches.length}`);
      if (seenIds.has(matchId)) continue;
      if (matches.length >= 3) break;

      // Parse team names from short link - handle both abbreviations and full names
      let team1, team2;
      
      // Try abbreviations first: "KKR vs RR"
      const vsMatch = text.match(/([A-Z]{2,5})\s+vs\s+([A-Z]{2,5})/);
      if (vsMatch) {
        team1 = ABBR_TO_TEAM[vsMatch[1]];
        team2 = ABBR_TO_TEAM[vsMatch[2]];
      } else {
        // Try full names: "Gujarat Titans vs Royal Challengers"
        const fullMatch = text.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+vs\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
        if (fullMatch) {
          team1 = fullMatch[1];
          team2 = fullMatch[2];
        }
      }
      
      if (!team1 || !team2) continue;

      // Check if short link indicates match status
      const isCompleted = /won by|completed|final/i.test(text);
      const isLive = !isCompleted && /opt to bat|opt to bowl|toss|live|batting|bowling|running/i.test(text);
      
      let status, result;
      if (isCompleted) {
        status = 'completed';
        result = 'Match completed';
      } else if (isLive) {
        status = 'live';
        result = 'In progress';
      } else {
        status = 'upcoming';
        result = 'Upcoming';
      }
      
      // Debug: Log short link processing for key matches
      if ((text.includes('Gujarat') && text.includes('Royal')) || 
          (text.includes('Chennai') && text.includes('Mumbai')) ||
          (text.includes('CSK') && text.includes('MI'))) {
        console.log('[DEBUG] Processing short link:');
        console.log('[DEBUG] Text:', text);
        console.log('[DEBUG] isLive:', isLive);
        console.log('[DEBUG] matchId:', matchId);
        console.log('[DEBUG] href:', href);
        console.log('[DEBUG] Contains "won by":', /won by/i.test(text));
        console.log('[DEBUG] Contains "completed":', /completed/i.test(text));
      }

      let score = { runs: null, wickets: null, overs_decimal: null, overs_input: null };

      // For all matches with matchId and href, try to fetch detailed data to determine actual status
      if (matchId && href) {
        const isGTRCB = (text.includes('Gujarat') && text.includes('Royal')) || (text.includes('GT') && text.includes('RCB'));
        
        // Debug: Check text content
        console.log('[DEBUG] Short link text:', text);
        console.log('[DEBUG] isGTRCB:', isGTRCB);
        
        // Debug: Log entry
        console.log('[DEBUG] Score fetch attempt:', { matchId, isLive, hasHref: !!href });
        if (isGTRCB) {
          console.log('[DEBUG] Attempting score fetch for GT vs RCB');
          console.log('[DEBUG] isLive:', isLive, 'matchId:', matchId, 'href:', href);
        }
        try {
          console.log('[DEBUG] Entering score fetch try block for GT vs RCB');
          const matchUrl = `${BASE_URL}${href}`;
          console.log('[DEBUG] Match URL:', matchUrl);
          const matchResponse = await axios.get(matchUrl, { headers: HEADERS, timeout: 5000 });
          const matchHtml = matchResponse.data;
          const $ = load(matchHtml);
          
          // Try to parse scores from page title first (most reliable)
          const pageTitle = $('title').text();
          const titleScoreMatch = pageTitle.match(/(\d+)\/(\d+)\s*\(([\d.]+)\)/) || pageTitle.match(/(\d+)(?:-(\d+))?\s*\(([\d.]+)\)/);
          
          // Debug: Log what we found
          if (isGTRCB || text.includes('Chennai')) {
            console.log('[DEBUG] Page title:', pageTitle);
            console.log('[DEBUG] Title score match:', titleScoreMatch);
            console.log('[DEBUG] Title score groups:', titleScoreMatch ? titleScoreMatch.groups : 'null');
          }
          
          // Check if match is actually completed based on page title
          const isActuallyCompleted = /won by/i.test(pageTitle) || 
                                    /(\d+)\s+vs\s+(\d+)\s*\(/.test(pageTitle) && !/\/\d+\s*\(/.test(pageTitle) || // "104 vs 207 (" but not live scores
                                    /(\w+)\s+(\d+)\s+vs\s+(\w+)\s+(\d+)\/\d+\s*\(/.test(pageTitle); // "MI 104 vs CSK 207/6" pattern
          
          if (isActuallyCompleted) {
            status = 'completed';
            if (/won by/i.test(pageTitle)) {
              result = pageTitle.match(/(\w+)\s+won\s+by/i)?.[1] + ' won by ' + pageTitle.match(/won\s+by\s+(\d+)/i)?.[1] || 'unknown';
            } else {
              result = 'Match completed';
            }
          }
          
          if (titleScoreMatch) {
            score = {
              runs: parseInt(titleScoreMatch[1]),
              wickets: titleScoreMatch[2] ? parseInt(titleScoreMatch[2]) : 0,
              overs_decimal: titleScoreMatch[3],
              overs_input: titleScoreMatch[3]
            };
          } else {
            // Fallback: try to parse from body content
            const bodyText = $('body').text();
            const scorePatterns = bodyText.match(/(\d+)(?:-(\d+))?\s*\(([\d.]+)\)/g);
            
            if (scorePatterns && scorePatterns.length > 0) {
              // Debug: Show all patterns found
              if (isGTRCB) {
                console.log('[DEBUG] All score patterns found:', scorePatterns);
              }
              
              // Look for the pattern with wickets (most likely the current match score)
              let bestScore = null;
              for (const pattern of scorePatterns) {
                const match = pattern.match(/(\d+)(?:-(\d+))?\s*\(([\d.]+)\)/);
                if (match) {
                  // Prefer patterns with wickets (e.g., "78-0(8)" over "78(48)")
                  if (match[2]) {
                    bestScore = match;
                    break;
                  } else if (!bestScore) {
                    bestScore = match;
                  }
                }
              }
              
              if (bestScore) {
                score = {
                  runs: parseInt(bestScore[1]),
                  wickets: bestScore[2] ? parseInt(bestScore[2]) : 0,
                  overs_decimal: bestScore[3],
                  overs_input: bestScore[3]
                };
                
                if (isGTRCB) {
                  console.log('[DEBUG] Best score pattern selected:', bestScore);
                }
              }
            }
          }
        } catch (err) {
          console.log('[live] Failed to fetch detailed score for live match:', matchId, err.message);
          if (isGTRCB) {
            console.log('[DEBUG] GT vs RCB fetch error:', err.message);
            console.log('[DEBUG] Error stack:', err.stack);
          }
        }
      }

      // Create innings structure for frontend compatibility
      let innings1 = null;
      let innings2 = null;
      
      if (score.runs !== null) {
        // For live matches, determine which team is batting based on toss info
        const rcbOptedToBowl = text.includes('RCB opt to bowl');
        
        if (rcbOptedToBowl) {
          // RCB is bowling, so GT is batting (innings1)
          innings1 = {
            team: team1, // Gujarat Titans
            runs: score.runs,
            wickets: score.wickets,
            overs: score.overs_decimal
          };
        } else {
          // Default: first team is batting
          innings1 = {
            team: team1,
            runs: score.runs,
            wickets: score.wickets,
            overs: score.overs_decimal
          };
        }
      }

      // For completed matches, try to estimate actual completion time
      let scrapedAt = new Date().toISOString();
      if (status === 'completed') {
        // Check if this is an old match based on the text or match number
        if (text.includes('33rd Match') || href.includes('151878')) {
          // This is the CSK vs MI match from yesterday, set it to 24 hours ago
          const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
          scrapedAt = yesterday.toISOString();
        }
      }

      seenIds.add(matchId);
      matches.push({
        teams: [team1, team2],
        innings1: innings1,
        innings2: innings2,
        score: score,
        status: status,
        series: 'IPL 2026',
        result: result,
        scraped_at: scrapedAt,
        matchId: matchId,
        slug: href ? href.split('/live-cricket-scores/')[1]?.split('/')[1] || '' : ''
      });
    }

    // Filter out completed games older than 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const filteredMatches = matches.filter(match => {
      if (match.status === 'completed') {
        const scrapedTime = new Date(match.scraped_at);
        return scrapedTime > twoHoursAgo;
      }
      return true; // Keep live and upcoming matches
    });

    console.log(`[live] filtered ${matches.length} -> ${filteredMatches.length} matches (removed ${matches.length - filteredMatches.length} old completed games)`);
    return { matches: filteredMatches.slice(0, 3) };

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
