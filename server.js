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

const ESPN_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.espn.com/',
  'Origin':          'https://www.espn.com',
};

async function syncFromESPN() {
  try {
    console.log('[ESPN] Syncing…');
    const res = await fetch(ESPN_URL, { headers: ESPN_HEADERS });
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
// Clear cache on startup so first request always gets fresh data
fullLbCache = null;
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
    const r = await fetch(ESPN_URL, { headers: ESPN_HEADERS });
    if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
    const json = await r.json();

    const event       = json.events?.[0];
    const competition = event?.competitions?.[0];
    if (!competition) return res.json({ notStarted: true, players: [] });

    const roundNum = competition.status?.period || 1; // current round (1-4)

    const numStr = n => n === null ? null : n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`;

    const players = (competition.competitors || []).map(comp => {
      const ls     = comp.linescores || [];
      const stat   = comp.status?.type?.name || '';
      const detail = (comp.status?.type?.shortDetail || '').trim();
      const isMC   = stat === 'STATUS_MISSED_CUT' || stat === 'STATUS_CUT';
      const isWD   = stat === 'STATUS_WITHDRAWN';

      // Completed round stroke totals (>50 guards against to-par values)
      const rounds = [0,1,2,3].map(i => {
        const v = Number(ls[i]?.value);
        return (!isNaN(v) && v > 50) ? v : null;
      });
      const validRounds    = rounds.filter(v => v !== null);
      const completedToPar = validRounds.reduce((s, v) => s + (v - 72), 0);

      // Parse shortDetail for in-progress: "-3 thru 5"
      const thruMatch       = detail.match(/([+-]?\d+|E)\s+thru\s+(\d+)/i);
      // Parse shortDetail for a clean score: "-5" or "E" or "+2"
      const cleanScoreMatch = detail.match(/^([+-]?\d+|E)$/i);

      let scoreNum  = null; // total tournament to-par (number)
      let todayNum  = null; // today's round to-par (number)
      let thruToday = null; // holes completed today (null=not started, 18=finished)

      if (isMC || isWD) {
        scoreNum = validRounds.length > 0 ? completedToPar : null;
      } else if (thruMatch) {
        // Currently on the course
        scoreNum  = parseToParNum(thruMatch[1]);
        thruToday = parseInt(thruMatch[2]);
        todayNum  = scoreNum !== null ? scoreNum - completedToPar : null;
      } else if (validRounds.length >= roundNum) {
        // Finished today's round (stroke total posted)
        scoreNum  = completedToPar;
        todayNum  = validRounds[roundNum - 1] !== undefined ? (validRounds[roundNum - 1] - 72) : null;
        thruToday = 18;
      } else if (cleanScoreMatch) {
        // ESPN has a final score but strokes not posted yet
        scoreNum  = parseToParNum(cleanScoreMatch[1]);
        todayNum  = validRounds.length > 0 ? scoreNum - completedToPar : scoreNum;
        thruToday = 18;
      } else if (validRounds.length > 0) {
        // Finished prior rounds, not yet started today
        scoreNum  = completedToPar;
      }

      // Build display strings
      const score = isMC ? 'MC' : isWD ? 'WD' : (numStr(scoreNum) ?? '-');
      let today = null;
      if (thruToday === 18) {
        today = numStr(todayNum) ?? '-';
      } else if (thruToday !== null && todayNum !== null) {
        today = `${numStr(todayNum)} (thru ${thruToday})`;
      }

      // Tee time — only for players whose status is explicitly not yet started
      const notStarted = stat === 'STATUS_SCHEDULED' || stat === 'STATUS_UPCOMING' || stat === '';
      const teeTimeCT  = notStarted && validRounds.length === 0 && !isMC && !isWD
        ? fmtTeeToCT(comp.teeTime || comp.status?.teeTime)
        : null;

      return {
        pos:      comp.status?.position?.displayName || '',
        name:     comp.athlete?.displayName || '',
        country:  comp.athlete?.flag?.alt || '',
        score,
        scoreNum,
        today,
        thruToday,
        rounds,
        isMC,
        isWD,
        teeTimeCT,
        sortOrder: comp.sortOrder ?? 9999,
      };
    });

    players.sort((a, b) => a.sortOrder - b.sortOrder);


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
