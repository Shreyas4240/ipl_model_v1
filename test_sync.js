const syncHandler = require('./api/sync');
const mockReq = {};
const mockRes = {
  status: function(code) { console.log("Status:", code); return this; },
  json: function(data) { console.log("Response:", data); return this; }
};
syncHandler(mockReq, mockRes).then(() => console.log("Done")).catch(console.error);
