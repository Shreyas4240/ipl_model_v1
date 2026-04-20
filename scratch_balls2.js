// Simulate api/scorecard.js locally
const axios = require('axios');
const HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.cricbuzz.com'};

function parseBallByBall(html) {
  const gridIdx = html.indexOf('Overs</div>');
  if (gridIdx < 0) return [];
  const section = html.slice(gridIdx, gridIdx + 80000);
  const plain = section.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lines = plain.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const overBlocks = [];
  let i = 0;
  while (i < lines.length) {
    const ovMatch = lines[i].match(/^Ov\s+(\d+)$/);
    if (ovMatch) {
      const overNum = parseInt(ovMatch[1]);
      if (i + 1 < lines.length) {
        const scoreMatch = lines[i + 1].match(/^(\d+)-(\d+)$/);
        if (scoreMatch) {
          const balls = [];
          let j = i + 3;
          while (j < lines.length && !lines[j].match(/^Ov\s+\d+$/) && !lines[j].match(/^FEATURED/)) {
            balls.push(lines[j]);
            j++;
          }
          overBlocks.push({ overNum, startRuns: parseInt(scoreMatch[1]), startWickets: parseInt(scoreMatch[2]), balls });
          i = j; continue;
        }
      }
    }
    i++;
  }

  overBlocks.sort((a, b) => a.overNum - b.overNum);

  const innings = [];
  let cur = [];
  for (const blk of overBlocks) {
    const prev = cur[cur.length - 1];
    if (prev && (blk.overNum < prev.overNum || blk.startRuns < prev.startRuns - 5)) { innings.push(cur); cur = []; }
    cur.push(blk);
  }
  if (cur.length) innings.push(cur);

  const result = [];
  innings.forEach((inn, innIdx) => {
    let cumRuns = 0, cumWickets = 0, ballSeq = 0;
    inn.forEach(blk => {
      cumRuns = blk.startRuns; cumWickets = blk.startWickets;
      const overNum = blk.overNum;
      let legalInOver = 0;
      const ballItems = blk.balls[blk.balls.length-1] && blk.balls[blk.balls.length-1].match(/^\d+$/) ? blk.balls.slice(0,-1) : blk.balls;
      for (const ball of ballItems) {
        const isWide = /^Wd/i.test(ball), isNoBall = /^Nb/i.test(ball);
        const isWicket = ball === 'W', isDot = ball === '•';
        const legBye = ball.match(/^L(\d+)$/), bye = ball.match(/^B(\d+)$/), runs = ball.match(/^(\d+)$/);
        let runsScored = 0, isLegal = true;
        if (isWide) { runsScored = 1; isLegal = false; }
        else if (isNoBall) { runsScored = 1; isLegal = false; }
        else if (isWicket) { cumWickets++; isLegal = true; }
        else if (isDot) { isLegal = true; }
        else if (legBye) { runsScored = parseInt(legBye[1]); }
        else if (bye) { runsScored = parseInt(bye[1]); }
        else if (runs) { runsScored = parseInt(runs[1]); }
        else continue;
        cumRuns += runsScored;
        if (isLegal) legalInOver++;
        ballSeq++;
        result.push({ innings: innIdx+1, ball: ballSeq, over: parseFloat(((overNum-1)+legalInOver/6).toFixed(3)), runs: cumRuns, wickets: cumWickets });
      }
    });
  });
  return result;
}

axios.get('https://www.cricbuzz.com/live-cricket-over-by-over/151840/pbks-vs-lsg-29th-match-indian-premier-league-2026', {headers: HEADERS, timeout: 15000})
  .then(r => {
    const balls = parseBallByBall(r.data);
    console.log('Total balls:', balls.length);
    // Print every 6th ball (end of over)
    balls.filter((b,i) => (i+1) % 6 === 0 || i === balls.length-1).forEach(b =>
      process.stdout.write(`Inn${b.innings} Ov${b.over.toFixed(1)} ball${b.ball}: ${b.runs}/${b.wickets}\n`)
    );
  })
  .catch(e => console.error(e.message));
