const requests = require('axios');
const { load } = require('cheerio');

const BASE_URL = 'https://www.cricbuzz.com';
const LIVE_URL = `${BASE_URL}/cricket-match/live-scores`;

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Referer': BASE_URL,
};

module.exports = async function handler(req, res) {
  console.log(`API called at: ${new Date().toISOString()}`);
  try {
    // Fetch the main live scores page
    const response = await requests.get(LIVE_URL, { headers, timeout: 15000 });
    
    const $ = load(response.data);
    const matches = [];
    const now = new Date().toISOString();
    
    // Look for match links that might contain IPL matches
    const matchLinks = $('a[href*="/live-cricket-scores/"]');
    console.log(`Found ${matchLinks.length} match links`);
    
    const teamMapping = {
      'Super Giants': 'Lucknow Super Giants',
      'Royal Challengers Bengaluru': 'Royal Challengers Bengaluru',
      'Royal Challengers Bangalore': 'Royal Challengers Bengaluru',
      'Indians': 'Mumbai Indians',
      'Punjab Kings': 'Punjab Kings',
      'Chennai Super Kings': 'Chennai Super Kings',
      'Kolkata Knight Riders': 'Kolkata Knight Riders',
      'Rajasthan Royals': 'Rajasthan Royals',
      'Delhi Capitals': 'Delhi Capitals',
      'Sunrisers Hyderabad': 'Sunrisers Hyderabad',
      'Gujarat Titans': 'Gujarat Titans',
      // Abbreviations
      'LSG': 'Lucknow Super Giants',
      'RCB': 'Royal Challengers Bengaluru',
      'MI': 'Mumbai Indians',
      'PBKS': 'Punjab Kings',
      'CSK': 'Chennai Super Kings',
      'KKR': 'Kolkata Knight Riders',
      'RR': 'Rajasthan Royals',
      'DC': 'Delhi Capitals',
      'SRH': 'Sunrisers Hyderabad',
      'GT': 'Gujarat Titans'
    };
    
    // Process match links searching for IPL games
    for (let i = 0; i < matchLinks.length; i++) {
      const link = matchLinks.eq(i);
      const href = link.attr('href');
      const linkText = link.text().trim();
      
      // Check if this looks like an IPL match
      if (!href || !href.includes('/live-cricket-scores/')) continue;
      
      // Extract team names from link text or nearby elements
      let teams = [];
      let matchInfo = '';
      
      // Try to get team names from the link text
      const teamPattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+vs\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)|([A-Z]{2,4})\s+vs\s+([A-Z]{2,4})/i;
      const teamMatch = linkText.match(teamPattern);
      
      if (teamMatch) {
        // Handle both full names (groups 1,2) and abbreviations (groups 3,4)
        const team1 = teamMatch[1] || teamMatch[3];
        const team2 = teamMatch[2] || teamMatch[4];
        teams = [teamMapping[team1] || team1, teamMapping[team2] || team2];
      } else {
        // Try to get from parent elements
        const parentText = link.parent().text();
        const parentTeamMatch = parentText.match(teamPattern);
        if (parentTeamMatch) {
          const parentTeam1 = parentTeamMatch[1] || parentTeamMatch[3];
          const parentTeam2 = parentTeamMatch[2] || parentTeamMatch[4];
          teams = [teamMapping[parentTeam1] || parentTeam1, teamMapping[parentTeam2] || parentTeam2];
        }
      }
      
      if (teams.length < 2) continue;
      
      // Check if these are IPL teams
      const isIplMatch = teams.some(team => Object.values(teamMapping).includes(team));
      if (!isIplMatch) continue;
      
      // Stop completely once we have 2 IPL matches
      if (matches.length >= 2) break;
      
      // Fetch the detailed match page
      try {
        const matchUrl = BASE_URL + href;
        const matchResponse = await requests.get(matchUrl, { headers, timeout: 10000 });
        const matchPage = load(matchResponse.data);
        
        // Extract score information from the match page
        let scoreData = {
          runs: null,
          wickets: null,
          overs_decimal: null,
          overs_input: null
        };
        
        let status = 'upcoming';
        let result = '';
        
        // Look for score elements
        const scoreElements = matchPage('.cb-font-20, .cb-min-bat-rw, .ui-bat-team-scores, [class*="score"], [class*="runs"]');
        const pageText = matchPage.text();
        const scoreTextToSearch = scoreElements.text();
        
        const textToSearch = scoreTextToSearch || pageText;
        let bestMatch = null;
        
        const scoreRegex = /(?:^|\s|>)([0-9]{1,3})\/([0-9]{1,2})(?:\s*\(([\d.]+)\s*(?:ov|Ovs)?\))?/gi;
        let matchPattern;
        while ((matchPattern = scoreRegex.exec(textToSearch)) !== null) {
            const r = parseInt(matchPattern[1]);
            const w = parseInt(matchPattern[2]);
            if (r <= 450 && w <= 10) {
                if (!bestMatch || matchPattern[3]) {
                    bestMatch = matchPattern;
                }
            }
        }
        
        if (!bestMatch && textToSearch !== pageText) {
            const fallbackRegex = /(?:^|\s|>)([0-9]{1,3})\/([0-9]{1,2})\s*\(([\d.]+)\s*(?:ov|Ovs)?\)/gi;
            let m2;
            while ((m2 = fallbackRegex.exec(pageText)) !== null) {
                 const r = parseInt(m2[1]);
                 const w = parseInt(m2[2]);
                 // Fallback on full page text STRICTLY REQUIRES overs to avoid matching dates like 24/04
                 if (r <= 450 && w <= 10 && m2[3]) {
                     bestMatch = m2;
                     break;
                 }
            }
        }

        if (bestMatch) {
          scoreData.runs = parseInt(bestMatch[1]);
          scoreData.wickets = parseInt(bestMatch[2]);
          if (bestMatch[3]) {
            scoreData.overs_decimal = bestMatch[3];
            scoreData.overs_input = bestMatch[3];
          }
        }
        
        // Determine match status - more robust logic
        console.log(`DEBUG: Initial score data:`, scoreData);
        
        const hasScore = scoreData.runs !== null;
        
        if (!hasScore) {
          // If no score was explicitly parsed from a live-scorecard widget, it's definitively upcoming (or abandoned)
          // Preview pages often contain historical "won by" snippets that cause false positives if checked first.
          status = 'upcoming';
          result = 'Upcoming match';
          console.log('DEBUG: No score found - defaulting to upcoming');
        } else if (pageText.toLowerCase().includes('won by') || matchPage('.cb-text-complete').length > 0) {
          // Check if it's truly completed by looking for stronger final result indicators
          const hasStrongFinalResult = pageText.toLowerCase().includes('won by') && 
                                      (pageText.toLowerCase().includes('innings') || 
                                       pageText.toLowerCase().includes('all out') ||
                                       scoreData.overs_decimal === '20.0');
          
          // Also check if it's a very recent match (less than 2 hours ago)
          const now = new Date();
          const matchTime = new Date(now);
          const hoursSinceMatch = (now - matchTime) / (1000 * 60 * 60);
          
          if (hasStrongFinalResult && hoursSinceMatch > 2) {
            status = 'completed';
            // Look for "Team won by X wkts/runs" pattern
            const wonByMatch = pageText.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+won\s+by\s+(\d+)\s+(wkts|runs)/i);
            if (wonByMatch) {
              const winner = teamMapping[wonByMatch[1]] || wonByMatch[1];
              result = `${winner} won by ${wonByMatch[2]} ${wonByMatch[3]}`;
            } else {
              result = 'Match completed';
            }
          } else {
            // Recent match or not clearly completed - treat as live
            status = 'live';
            result = 'In progress';
          }
        } else if (pageText.toLowerCase().includes('live') || pageText.toLowerCase().includes('live now')) {
          status = 'live';
          result = 'In progress';
        } else {
          // Has score but no clear completion or live indicators - treat as live
          status = 'live';
          result = 'In progress';
        }
        
        console.log(`DEBUG: Final status: ${status}, result: ${result}, score:`, scoreData);
        
        // Extract match number
        const matchNumberMatch = pageText.match(/(\d+(?:st|nd|rd|th)\s+Match)/i);
        matchInfo = matchNumberMatch ? matchNumberMatch[1] : 'Match';
        
        matches.push({
          teams: teams,
          score: scoreData,
          status: status,
          series: 'IPL 2026',
          result: result,
          scraped_at: now
        });
        
        // Add small delay to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (matchError) {
        console.log(`Failed to fetch match details for ${href}:`, matchError.message);
        // Still add the match with basic info
        matches.push({
          teams: teams,
          score: { runs: null, wickets: null, overs_decimal: null, overs_input: null },
          status: 'upcoming',
          series: 'IPL 2026',
          result: 'Match details unavailable',
          scraped_at: now
        });
      }
    }
    
    // Normalize team names to prevent duplicates
    const normalizeTeam = (team) => {
      if (!team) return team;
      return team.replace(/\s+/g, ' ').trim().toLowerCase();
    };
    
    // Remove duplicates based on team combinations
    const uniqueMatches = [];
    const seenTeams = new Set();
    
    for (const match of matches) {
      if (match.teams && match.teams.length >= 2) {
        const normalizedTeams = match.teams.map(normalizeTeam);
        const teamKey = normalizedTeams.slice().sort().join('|');
        if (!seenTeams.has(teamKey)) {
          seenTeams.add(teamKey);
          uniqueMatches.push(match);
        }
      } else {
        uniqueMatches.push(match); // Keep if no teams or single team
      }
    }
    
    // Limit to 2 matches (today's game + tomorrow's game) to cut out old games
    const activeMatches = uniqueMatches.slice(0, 2);
    
    return res.status(200).json({ matches: activeMatches });
    
  } catch (error) {
    console.error('Error fetching Cricbuzz:', error);
    return res.status(500).json({ 
      error: `Failed to fetch Cricbuzz: ${error.message}`, 
      matches: [] 
    });
  }
}
