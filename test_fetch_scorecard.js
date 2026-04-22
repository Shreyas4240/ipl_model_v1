const { fetchAndMergeScorecard } = require('./api/scorecard');
async function test() {
  const matchId = "151867";
  const slug = "rr-vs-lsg-32nd-match-indian-premier-league-2026";
  const balls = await fetchAndMergeScorecard(matchId, slug);
  console.log("Returned balls length:", balls.length);
  if (balls.length > 0) {
    console.log("First:", balls[0]);
    console.log("Last:", balls[balls.length - 1]);
  }
}
test().catch(console.error);
