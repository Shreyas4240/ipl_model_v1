import fs from 'fs';
import path from 'path';

function getMatchMetadata(jsonDir) {
  const meta = {};
  if (!fs.existsSync(jsonDir) || !fs.statSync(jsonDir).isDirectory()) return meta;
  const files = fs.readdirSync(jsonDir);
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(jsonDir, name);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const info = data.info || {};
      const dates = info.dates || [];
      const dateStr = dates[0] || null;
      const teams = info.teams || [];
      const event = info.event || {};
      const eventName = typeof event === 'object' && event ? event.name || '' : '';
      const venue = info.venue || info.city || '';
      meta[name] = {
        date: dateStr,
        teams,
        event: eventName,
        venue,
      };
    } catch {
      // ignore bad JSON
    }
  }
  return meta;
}

const MIN_DATA_YEAR = 2023;

function getRecentAndUpcoming(meta, pastDays) {
  const today = new Date();
  const cutoff = new Date(today.getTime() - Math.min(pastDays, 365 * 50) * 24 * 3600 * 1000);
  const recent = [];
  const upcoming = [];
  for (const [matchFile, m] of Object.entries(meta)) {
    if (!m.date) continue;
    const matchYear = parseInt(String(m.date).slice(0, 4), 10);
    if (!Number.isFinite(matchYear) || matchYear < MIN_DATA_YEAR) continue;
    const d = new Date(m.date);
    if (isNaN(d.getTime())) continue;
    if (d >= today) {
      upcoming.push({ matchFile, meta: m, date: d });
    } else if (d >= cutoff) {
      recent.push({ matchFile, meta: m, date: d });
    }
  }
  recent.sort((a, b) => b.date - a.date);
  upcoming.sort((a, b) => a.date - b.date);
  return { recent, upcoming };
}

export default function handler(req, res) {
  try {
    const root = process.cwd();
    const jsonDir = path.join(root, 'ipl_male_json');
    const meta = getMatchMetadata(jsonDir);
    const { upcoming } = getRecentAndUpcoming(meta, 365);
    const fixtures = upcoming.map(({ matchFile, meta: m }) => ({
      match_file: matchFile,
      date: m.date,
      teams: m.teams,
      event: m.event,
      venue: m.venue,
      source: 'local',
    }));
    res.status(200).json({ fixtures });
  } catch (err) {
    res.status(500).json({ error: String(err), fixtures: [] });
  }
}

