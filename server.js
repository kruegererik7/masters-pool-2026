const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const MEMBERS = ['Danny','Tony','Hugo','Zach','Diego','Erik','Drew','Andy','Tyreese','Jonny'];

// ── Team picks — update here and redeploy to change ───────────────────
// Note: Ludvig Åberg uses special Å character to match ESPN exactly
const TEAM_PICKS = {
  Danny:   ['Scottie Scheffler', 'Sepp Straka', 'Adam Scott', '', ''],
  Tony:    ['Ludvig \u00c5berg', 'Patrick Cantlay', 'Sungjae Im', '', ''],
  Hugo:    ['Bryson DeChambeau', 'Viktor Hovland', '', '', ''],
  Zach:    ['Rory McIlroy', 'Min Woo Lee', '', '', ''],
  Diego:   ['Cameron Young', 'Akshay Bhatia', '', '', ''],
  Erik:    ['Jon Rahm', 'Hideki Matsuyama', '', '', ''],
  Drew:    ['Xander Schauffele', 'Justin Rose', '', '', ''],
  Andy:    ['J.J. Spaun', 'Matthew Fitzpatrick', '', '', ''],
  Tyreese: ['Collin Morikawa', 'Ben Griffin', '', '', ''],
  Jonny:   ['Chris Gotterup', 'Tommy Fleetwood', '', '', ''],
};

const DEFAULT_DATA = {
  teams:      TEAM_PICKS,
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

let appData  = loadData();
// Always apply latest picks from code (survives redeploys)
appData.teams = TEAM_PICKS;
saveData();

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

// ── Full leaderboard proxy (all field players, cached 3 min) ──────────
let fullLbCache     = null;
let fullLbCacheTime = 0;
const FULL_LB_TTL   = 3 * 60 * 1000;
const AUGUSTA_PAR   = 72;

function toParStr(strokes, roundsPlayed) {
  if (!strokes || !roundsPlayed) return 'E';
  const diff = strokes - (roundsPlayed * AUGUSTA_PAR);
  return diff === 0 ? 'E' : diff > 0 ? `+${diff}` : `${diff}`;
}

app.get('/api/full-leaderboard', async (_req, res) => {
  const now = Date.now();
  if (fullLbCache && (now - fullLbCacheTime) < FULL_LB_TTL)
    return res.json(fullLbCache);

  try {
    const r = await fetch(ESPN_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
    const json = await r.json();

    const event       = json.events?.[0];
    const competition = event?.competitions?.[0];
    if (!competition) return res.json({ notStarted: true, players: [] });

    const players = (competition.competitors || []).map(comp => {
      const ls    = comp.linescores || [];
      const stat  = comp.status?.type?.name || '';
      const isMC  = stat === 'STATUS_MISSED_CUT' || stat === 'STATUS_CUT';
      const isWD  = stat === 'STATUS_WITHDRAWN';

      // Stroke total per round (>50 guards against to-par values)
      const rounds = [0,1,2,3].map(i => {
        const v = Number(ls[i]?.value);
        return (!isNaN(v) && v > 50) ? v : null;
      });

      const validRounds  = rounds.filter(v => v !== null);
      const totalStrokes = validRounds.reduce((a, b) => a + b, 0);

      // Total to-par — prefer ESPN's shortDetail, fall back to calculating
      let toPar = comp.status?.type?.shortDetail || '';
      if (!toPar || toPar.toLowerCase().includes('hole') || toPar.toLowerCase() === 'in progress') {
        toPar = isMC ? 'MC' : isWD ? 'WD' : validRounds.length ? toParStr(totalStrokes, validRounds.length) : '-';
      }
      if (toPar.toUpperCase() === 'MC' && isMC) toPar = 'MC';

      // Today = most recently started round
      let todayIdx = -1;
      for (let i = 3; i >= 0; i--) { if (rounds[i] !== null) { todayIdx = i; break; } }
      const todayStrokes = todayIdx >= 0 ? rounds[todayIdx] : null;
      const todayToPar   = todayStrokes ? toParStr(todayStrokes, 1) : null;

      return {
        pos:          comp.status?.position?.displayName || '',
        name:         comp.athlete?.displayName || '',
        country:      comp.athlete?.flag?.alt || '',
        toPar,
        rounds,
        todayStrokes,
        todayToPar,
        isMC,
        isWD,
        sortOrder:    comp.sortOrder ?? 9999,
      };
    });

    players.sort((a, b) => a.sortOrder - b.sortOrder);

    const roundNum    = competition.status?.period || 0;
    const roundLabels = ['', 'Round 1', 'Round 2', 'Round 3', 'Round 4'];

    fullLbCache = {
      eventName:   event.name || 'Masters Tournament',
      roundLabel:  roundLabels[roundNum] || `Round ${roundNum}`,
      roundStatus: competition.status?.type?.description || '',
      lastFetched: new Date().toISOString(),
      poolGolfers: [...getPoolGolfers()],
      players,
    };
    fullLbCacheTime = now;
    res.json(fullLbCache);
  } catch (e) {
    console.error('[FullLB]', e.message);
    res.status(500).json({ error: e.message, players: [] });
  }
});

app.listen(PORT, () => console.log(`Masters Pool running on port ${PORT}`));
