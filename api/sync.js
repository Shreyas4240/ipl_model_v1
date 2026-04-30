const live = require('./live');
const getLiveMatchesData =
  typeof live.getLiveMatchesData === 'function'
    ? live.getLiveMatchesData
    : (typeof live === 'function' ? live : null);
const { fetchAndMergeScorecard } = require('./scorecard');

module.exports = async function handler(req, res) {
  try {
    console.log('[sync] Calling live handler internally...');
    if (typeof getLiveMatchesData !== 'function') {
      throw new Error('Live data function unavailable');
    }
    const liveData = await getLiveMatchesData();
    
    if (!liveData || !liveData.matches) {
       return res.status(500).json({ success: false, msg: 'Failed to fetch internal live matches' });
    }
    
    const matches = liveData.matches;
    const liveMatches = matches.filter(m => (m.status === 'live' || m.status === 'completed') && m.matchId && m.slug);
    console.log(`[sync] Found ${liveMatches.length} live/completed matches to sync`);
    
    for (const m of liveMatches) {
        console.log(`[sync] Syncing ${m.matchId}/${m.slug}...`);
        await fetchAndMergeScorecard(m.matchId, m.slug);
    }
    
    return res.status(200).json({ success: true, synced: liveMatches.length });
  } catch (err) {
    console.error('[sync] Error', err.message);
    return res.status(500).json({ error: err.message });
  }
};
