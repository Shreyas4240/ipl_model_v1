const live = require('./api/live.js');
const resMock = { status: function(c) { return this; }, json: function(d) { console.log(JSON.stringify(d, null, 2)); return this; } };
live({}, resMock);
