const { clearMatchData } = require('../scorecard.js');

module.exports = async function handler(req, res) {
  const matchId = req.query.matchId;
  
  if (!matchId) {
    return res.status(400).json({ error: 'matchId required' });
  }

  try {
    const success = await clearMatchData(matchId);
    if (success) {
      return res.status(200).json({ message: `Data cleared for match ${matchId}` });
    } else {
      return res.status(500).json({ error: 'Failed to clear match data' });
    }
  } catch (err) {
    console.error('[scorecard clear] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
