const { getLiveMatchesData } = require('./api/live');
getLiveMatchesData().then(d => console.log(JSON.stringify(d, null, 2))).catch(console.error);
