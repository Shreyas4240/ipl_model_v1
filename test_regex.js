// Test the regex patterns for GT vs RCB
const text = "Gujarat Titans vs Royal Challengers Bengaluru LIVE34th Match";

console.log('Testing regex patterns on:', text);
console.log('');

// Test abbreviation pattern
const vsMatch = text.match(/([A-Z]{2,5})\s+vs\s+([A-Z]{2,5})/);
console.log('Abbreviation pattern result:', vsMatch);

// Test full name pattern
const fullMatch = text.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+vs\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
console.log('Full name pattern result:', fullMatch);

// Test alternative patterns
const altMatch1 = text.match(/([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+vs\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
console.log('Alternative pattern 1:', altMatch1);

const altMatch2 = text.match(/([A-Za-z\s]+)\s+vs\s+([A-Za-z\s]+)/);
console.log('Alternative pattern 2:', altMatch2);

// Simple split approach
const parts = text.split(/\s+vs\s+/);
console.log('Simple split result:', parts);

if (parts.length >= 2) {
  const team1 = parts[0].trim();
  const team2 = parts[1].replace(/\s+LIVE.*/, '').trim();
  console.log('Team1:', team1);
  console.log('Team2:', team2);
}
