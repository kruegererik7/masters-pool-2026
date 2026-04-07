const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const MEMBERS = ['Danny','Tony','Hugo','Zach','Diego','Erik','Drew','Andy','Tyreese','Jonny'];

const DEFAULT_DATA = {
  teams:      Object.fromEntries(MEMBERS.map(m => [m, ['','','','','']])),
  scores:     {},
  penalties:  { r3: null, r4: null },
  lastSync:   null,
  syncStatus: 'never synced'
};

// ── Data helpers ──────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('Load error:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(appData, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

let appData = loadData();

// ── ESPN Sync ─────────────────────────────────────────────────────────
const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga';

function getPoolGolfers() {
  const set = new Set();
  Object.values(appData.teams).forEach(picks =>
    picks.forEach(p => { if (p && p.trim()) set.add(p.trim()); })
  );
  return set;
}

async function syncFromESPN() {
  try {
    console.log('[ESPN] Syncing…');
    const res = await fetch(ESPN_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    const event = json.events?.[0];
    if (!event) throw new Error('No active tournament in ESPN feed');

    const competition = event.competitions?.[0];
    if (!competition) throw new Error('No competition data');

    const poolGolfers  = getPoolGolfers();
    const fieldR3 = [];
    const fieldR4 = [];

    for (const comp of (competition.competitors || [])) {
      const name = comp.athlete?.displayName;
      if (!name) continue;

      const ls   = comp.linescores || [];
      const stat = comp.status?.type?.name || '';
      const isMC = stat === 'STATUS_MISSED_CUT' || stat === 'STATUS_CUT'
                || (comp.status?.type?.shortDetail || '').toUpperCase() === 'MC';

      // Collect field scores for auto-penalty calculation (active players only)
      const r3v = Number(ls[2]?.value);
      const r4v = Number(ls[3]?.value);
      if (!isMC && r3v > 50) fieldR3.push(r3v);  // >50 guards against relative-to-par values
      if (!isMC && r4v > 50) fieldR4.push(r4v);

      // Only update golfers in our pool (case-insensitive match)
      const poolName = [...poolGolfers].find(
        g => g.toLowerCase() === name.toLowerCase()
      );
      if (!poolName) continue;

      const parseVal = v => {
        const n = Number(v);
        return (!isNaN(n) && n > 50) ? n : null; // stroke totals are always >50
      };

      appData.scores[poolName] = {
        r1: parseVal(ls[0]?.value),
        r2: parseVal(ls[1]?.value),
        r3: isMC ? 'MC' : parseVal(ls[2]?.value),
        r4: isMC ? 'MC' : parseVal(ls[3]?.value),
      };
    }

    // Auto-calculate worst score in field for penalty (only if we have data)
    if (fieldR3.length) appData.penalties.r3 = Math.max(...fieldR3);
    if (fieldR4.length) appData.penalties.r4 = Math.max(...fieldR4);

    appData.lastSync   = new Date().toISOString();
    appData.syncStatus = `ok — ${event.name || 'tournament'}`;
    saveData();
    console.log('[ESPN] Sync OK:', appData.lastSync);

  } catch (e) {
    console.error('[ESPN] Sync error:', e.message);
    appData.lastSync   = new Date().toISOString();
    appData.syncStatus = 'error: ' + e.message;
    saveData();
  }
}

// Sync immediately on startup, then every 5 minutes
syncFromESPN();
setInterval(syncFromESPN, 5 * 60 * 1000);

// ── Express ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET all data (frontend polls this)
app.get('/api/data', (_req, res) => res.json(appData));

// Save team picks
app.post('/api/teams', (req, res) => {
  if (!req.body?.teams) return res.status(400).json({ error: 'missing teams' });
  appData.teams = req.body.teams;
  saveData();
  res.json({ ok: true });
});

// Save manual scores / penalties
app.post('/api/scores', (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'missing body' });
  appData.scores    = req.body.scores    ?? appData.scores;
  appData.penalties = req.body.penalties ?? appData.penalties;
  saveData();
  res.json({ ok: true });
});

// Trigger a manual ESPN sync
app.post('/api/sync', async (_req, res) => {
  await syncFromESPN();
  res.json({ ok: true, lastSync: appData.lastSync, syncStatus: appData.syncStatus });
});

app.listen(PORT, () => console.log(`Masters Pool running on port ${PORT}`));
