const getLiveMatches = require('./live');
const { fetchAndMergeScorecard } = require('./scorecard');

module.exports = async function handler(req, res) {
  try {
    const resMock = {
      statusCode: 200,
      data: null,
      status: function(code) { this.statusCode = code; return this; },
      json: function(data) { this.data = data; return this; }
    };
    
    console.log('[sync] Calling live handler internally...');
    await getLiveMatches({}, resMock);
    
    if (resMock.statusCode !== 200 || !resMock.data || !resMock.data.matches) {
       return res.status(500).json({ success: false, msg: 'Failed to fetch internal live matches' });
    }
    
    const matches = resMock.data.matches;
    const liveMatches = matches.filter(m => m.status === 'live' && m.matchId && m.slug);
    console.log(`[sync] Found ${liveMatches.length} live matches to sync`);
    
    for (const m of liveMatches) {
        console.log(`[sync] Syncing ${m.matchId}/${m.slug}...`);
        await fetchAndMergeScorecard(m.matchId, m.slug, m.innings2 ? 2 : 1);
    }
    
    return res.status(200).json({ success: true, synced: liveMatches.length });
  } catch (err) {
    console.error('[sync] Error', err.message);
    return res.status(500).json({ error: err.message });
  }
};
