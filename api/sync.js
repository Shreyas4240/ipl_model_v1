const live = require('./live');
const getLiveMatchesData =
  typeof live.getLiveMatchesData === 'function'
    ? live.getLiveMatchesData
    : (typeof live === 'function' ? live : null);
const { fetchAndMergeScorecard, redisGet } = require('./scorecard');

// Completed matches don't change — skip re-sync if updated within last 30 min.
const COMPLETED_COOLDOWN_MS = 30 * 60 * 1000;

async function shouldSkipCompleted(matchId) {
  try {
    const meta = await redisGet(`scorecard_meta_${matchId}`);
    if (!meta || !meta[0] || !meta[0].updatedAt) return false;
    const age = Date.now() - new Date(meta[0].updatedAt).getTime();
    return age < COMPLETED_COOLDOWN_MS;
  } catch (_) {
    return false;
  }
}

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
    const eligible = matches.filter(m => (m.status === 'live' || m.status === 'completed') && m.matchId && m.slug);
    console.log(`[sync] Found ${eligible.length} live/completed matches`);

    const synced = [], skipped = [];
    for (const m of eligible) {
      if (m.status === 'completed' && await shouldSkipCompleted(m.matchId)) {
        console.log(`[sync] Skipping completed match ${m.matchId} (synced recently)`);
        skipped.push(m.matchId);
        continue;
      }
      console.log(`[sync] Syncing ${m.matchId}/${m.slug}...`);
      await fetchAndMergeScorecard(m.matchId, m.slug);
      synced.push(m.matchId);
    }
    
    return res.status(200).json({ success: true, synced: synced.length, skipped: skipped.length });
  } catch (err) {
    console.error('[sync] Error', err.message);
    return res.status(500).json({ error: err.message });
  }
};
