const { getLiveMatchesData } = require('../api/live');

async function test() {
    console.log('Testing live API scraper...');
    try {
        const data = await getLiveMatchesData();
        console.log('Live API Response:', JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Scraper error:', e.message);
    }
}

test();
