const handler = require('../api/predict');

async function test() {
    const mockRes = {
        setHeader: (k, v) => console.log(`Header: ${k} = ${v}`),
        status: (code) => {
            console.log(`Status: ${code}`);
            return {
                json: (data) => console.log('Response Body:', JSON.stringify(data, null, 2))
            };
        }
    };
    
    const mockReq = {
        query: {}
    };

    console.log('Running predict API test...');
    await handler(mockReq, mockRes);
}

test().catch(console.error);
