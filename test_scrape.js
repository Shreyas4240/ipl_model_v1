const { getLiveMatchesData } = require('./api/live');
async function test() {
  const liveData = await getLiveMatchesData();
  console.log(JSON.stringify(liveData.matches, null, 2));
}
test().catch(console.error);
