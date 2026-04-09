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
  Danny:   ['Scottie Scheffler', 'Sepp Straka', 'Adam Scott', 'Harris English', 'Jason Day'],
  Tony:    ['Ludvig \u00c5berg', 'Patrick Cantlay', 'Sungjae Im', 'Tony Finau', 'Shane Lowry'],
  Hugo:    ['Bryson DeChambeau', 'Viktor Hovland', 'Jordan Spieth', 'Sam Burns', 'Kurt Kitayama'],
  Zach:    ['Rory McIlroy', 'Min Woo Lee', 'Robert MacIntyre', 'Gary Woodland', 'Nicolai H\u00f8jgaard'],
  Diego:   ['Cameron Young', 'Akshay Bhatia', 'Jake Knapp', 'Maverick McNealy', 'Cameron Smith'],
  Erik:    ['Jon Rahm', 'Hideki Matsuyama', 'Corey Conners', 'Justin Thomas', 'Tyrrell Hatton'],
  Drew:    ['Xander Schauffele', 'Justin Rose', 'Patrick Reed', 'Brooks Koepka', 'Marco Penge'],
  Andy:    ['J.J. Spaun', 'Matthew Fitzpatrick', 'Jacob Bridgeman', 'Si Woo Kim', 'Daniel Berger'],
  Tyreese: ['Collin Morikawa', 'Ben Griffin', 'Michael Kim', 'Harry Hall', 'Carlos Ortiz'],
  Jonny:   ['Chris Gotterup', 'Tommy Fleetwood', 'Russell Henley', 'Nico Echavarria', 'Rasmus H\u00f8jgaard'],
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

// Parse "E", "-3", "+2" → number (0, -3, 2)
function parseToParNum(str) {
  if (!str) return null;
  const s = str.trim().toUpperCase();
  if (s === 'E' || s === 'EVEN') return 0;
  const n = parseInt(s.replace(/^\+/, ''), 10);
  return isNaN(n) ? null : n;
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

    const poolGolfers = getPoolGolfers();
    let worstR3ToPar = null, worstR4ToPar = null;

    for (const comp of (competition.competitors || [])) {
      const name = comp.athlete?.displayName;
      if (!name) continue;

      const ls       = comp.linescores || [];
      const detail   = (comp.status?.type?.shortDetail || '').trim();
      const statName = comp.status?.type?.name || '';
      const isMC     = statName === 'STATUS_MISSED_CUT' || statName === 'STATUS_CUT';
      const isWD     = statName === 'STATUS_WITHDRAWN';

      // Completed rounds have stroke totals > 50 in linescores
      const roundStrokes = [0,1,2,3].map(i => {
        const v = Number(ls[i]?.value);
        return (!isNaN(v) && v > 50) ? v : null;
      });
      const numComplete = roundStrokes.filter(v => v !== null).length;

      // Parse shortDetail:
      //   "-3 thru 12"  → in progress, tournament to-par = -3, thru 12 holes
      //   "F" / "-5"    → finished for the day
      //   "MC" / "WD"   → special statuses
      //   "9:15 AM"     → not yet started
      let inProgress = false, thru = null, tourneyToPar = null, finishedToday = false;
      const thruMatch = detail.match(/(.+?)\s+thru\s+(\d+)/i);
      if (thruMatch) {
        inProgress   = true;
        thru         = parseInt(thruMatch[2], 10);
        tourneyToPar = parseToParNum(thruMatch[1]);
      } else if (/^F$/i.test(detail) || /^(E|[+-]\d+|\d+)$/.test(detail)) {
        finishedToday = true;
      }

      // Build rich per-round objects
      const roundData = {};
      let cumToPar = 0; // sum of completed rounds' to-par (for deriving current round to-par)

      for (let i = 0; i < 4; i++) {
        const rKey = `r${i + 1}`;
        if (isMC && i >= 2) {
          roundData[rKey] = { strokes: null, toPar: null, thru: null, status: 'MC' };
        } else if (roundStrokes[i] !== null) {
          // Completed round — we have final strokes
          const rToPar = roundStrokes[i] - 72;
          roundData[rKey] = { strokes: roundStrokes[i], toPar: rToPar, thru: 18, status: 'complete' };
          cumToPar += rToPar;
        } else if (i === numComplete && !isMC && !isWD && !finishedToday) {
          // Current round — player is in progress
          if (inProgress && tourneyToPar !== null) {
            roundData[rKey] = {
              strokes: null,
              toPar:   tourneyToPar - cumToPar, // current-round to-par = tournament total minus completed rounds
              thru,
              status:  'inprogress'
            };
          } else {
            roundData[rKey] = { strokes: null, toPar: null, thru: null, status: 'notstarted' };
          }
        } else {
          roundData[rKey] = { strokes: null, toPar: null, thru: null, status: 'notstarted' };
        }
      }

      // Track worst to-par in field for auto-penalty
      const r3d = roundData.r3, r4d = roundData.r4;
      if (r3d?.status === 'complete' && r3d.toPar !== null)
        worstR3ToPar = worstR3ToPar === null ? r3d.toPar : Math.max(worstR3ToPar, r3d.toPar);
      if (r4d?.status === 'complete' && r4d.toPar !== null)
        worstR4ToPar = worstR4ToPar === null ? r4d.toPar : Math.max(worstR4ToPar, r4d.toPar);

      // Only save pool golfers
      const poolName = [...poolGolfers].find(g => g.toLowerCase() === name.toLowerCase());
      if (poolName) appData.scores[poolName] = roundData;
    }

    if (worstR3ToPar !== null) appData.penalties.r3 = worstR3ToPar;
    if (worstR4ToPar !== null) appData.penalties.r4 = worstR4ToPar;

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

// Convert an ISO tee-time string to Central time with CDT/CST label
function fmtTeeToCT(isoStr) {
  if (!isoStr) return null;
  try {
    const d = new Date(isoStr);
    if (isNaN(d)) return null;
    const time = d.toLocaleTimeString('en-US', {
      timeZone: 'America/Chicago',
      hour:     'numeric',
      minute:   '2-digit',
      hour12:   true,
    });
    // Determine CDT vs CST (CDT = March–Nov, CST = Nov–Mar)
    const month = d.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'numeric' });
    const m = parseInt(month);
    const isDST = m >= 3 && m <= 11;
    return `${time} ${isDST ? 'CDT' : 'CST'}`;
  } catch { return null; }
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

      // Tee time (only relevant for players who haven't started)
      const teeTimeCT = validRounds.length === 0 && !isMC && !isWD
        ? fmtTeeToCT(comp.status?.teeTime)
        : null;

      return {
        pos:          comp.status?.position?.displayName || '',
        name:         comp.athlete?.displayName || '',
        country:      comp.athlete?.flag?.alt || '',
        toPar,
        rounds,
        todayStrokes,
        todayToPar,
        teeTimeCT,
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
