const { clearMatchData } = require('./api/scorecard');

const mockMatchData = {
  matchId: "123456",
  status: "live",
  innings2: false,
  score: {
    runs: 67,
    wickets: 2,
    overs_decimal: "6.4",
    overs_input: "6.4"
  }
};

const currentInnings = mockMatchData.innings2 ? 2 : 1;
const currentScore = mockMatchData.score;

const oversRaw = parseFloat(currentScore.overs_decimal || '0');
const overNum = Math.floor(oversRaw);
const ballsStr = (oversRaw - overNum).toFixed(1);
const ballsDec = parseInt(ballsStr.split('.')[1] || '0');
const exactOver = parseFloat((overNum + (ballsDec / 6)).toFixed(4));

const scraped = [{
  innings: currentInnings,
  ball: 1, // Will be re-sequenced by mergeBalls
  over: exactOver,
  overLabel: currentScore.overs_input || '0.0',
  runs: currentScore.runs || 0,
  wickets: currentScore.wickets || 0,
}];

console.log(JSON.stringify(scraped, null, 2));
