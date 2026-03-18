require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const webpush = require('web-push');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;
const isPostgres = !!process.env.DATABASE_URL;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
};

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  sessionConfig.cookie.secure = true;
}

app.use(session(sessionConfig));
app.use(passport.initialize());
app.use(passport.session());

let db;
let pool;

function makeTeamCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function normalizeTeamVisibility(value) {
  return value === 'public' ? 'public' : 'private';
}

function getDateParts() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = now.toISOString().slice(0, 10);
  const day = new Date(now);
  const weekDay = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - weekDay);
  const weekStart = day.toISOString().slice(0, 10);
  return { year, month, date, weekStart };
}

async function initDb() {
  if (isPostgres) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        team_code TEXT NOT NULL,
        weekly_goal INTEGER NOT NULL DEFAULT 0,
        monthly_goal INTEGER NOT NULL DEFAULT 0,
        yearly_goal INTEGER NOT NULL DEFAULT 0,
        streak_count INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT 'local',
        provider_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_count INTEGER NOT NULL DEFAULT 0;`).catch(()=>{});
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS best_streak INTEGER NOT NULL DEFAULT 0;`).catch(()=>{});
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'local';`).catch(()=>{});
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_id TEXT;`).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        team_code TEXT PRIMARY KEY,
        team_name TEXT NOT NULL DEFAULT 'Mein Team',
        visibility TEXT NOT NULL DEFAULT 'private',
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pushups (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL,
        entry_date DATE NOT NULL,
        note TEXT DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        subscription_json JSONB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
  } else {
    const Database = require('better-sqlite3');
    const dataDir = path.join(__dirname, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(path.join(dataDir, 'pushups.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        team_code TEXT NOT NULL,
        weekly_goal INTEGER NOT NULL DEFAULT 0,
        monthly_goal INTEGER NOT NULL DEFAULT 0,
        yearly_goal INTEGER NOT NULL DEFAULT 0,
        streak_count INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT 'local',
        provider_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS teams (
        team_code TEXT PRIMARY KEY,
        team_name TEXT NOT NULL DEFAULT 'Mein Team',
        visibility TEXT NOT NULL DEFAULT 'private',
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS pushups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        entry_date TEXT NOT NULL,
        note TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        subscription_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
  }
}

async function q(sql, params = []) {
  if (isPostgres) {
    const result = await pool.query(sql, params);
    return result.rows;
  }
  const statement = db.prepare(sql);
  const normalized = sql.trim().toLowerCase();
  if (normalized.startsWith('select')) return statement.all(params);
  const info = statement.run(params);
  return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    done(null, await getUserById(id));
  } catch (e) {
    done(e);
  }
});

function configurePassport() {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
    }, async (_accessToken, _refreshToken, profile, done) => {
      try {
        const user = await findOrCreateOAuthUser({
          provider: 'google',
          providerId: profile.id,
          usernameBase: profile.displayName || profile.emails?.[0]?.value || 'google-user'
        });
        done(null, user);
      } catch (e) { done(e); }
    }));
  }


}

async function findOrCreateOAuthUser({ provider, providerId, usernameBase }) {
  const existing = await getUserByProvider(provider, providerId);
  if (existing) return existing;

  let username = String(usernameBase || provider).replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase() || provider;
  let suffix = 1;
  while (await getUserByUsername(username)) {
    username = `${usernameBase.toLowerCase().replace(/[^a-zA-Z0-9._-]/g, '') || provider}${suffix++}`;
  }
  const teamCode = makeTeamCode();
  let userId;
  if (isPostgres) {
    await q(`INSERT INTO teams (team_code, team_name, visibility) VALUES ($1, $2, $3) ON CONFLICT (team_code) DO NOTHING`, [teamCode, `${username}'s Team`, 'private']);
    const rows = await q(`INSERT INTO users (username, password_hash, team_code, provider, provider_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [username, null, teamCode, provider, providerId]);
    userId = rows[0].id;
    await q(`UPDATE teams SET created_by = COALESCE(created_by, $1) WHERE team_code = $2`, [userId, teamCode]);
  } else {
    await q(`INSERT OR IGNORE INTO teams (team_code, team_name, visibility) VALUES (?, ?, ?)`, [teamCode, `${username}'s Team`, 'private']);
    const result = await q(`INSERT INTO users (username, password_hash, team_code, provider, provider_id) VALUES (?, ?, ?, ?, ?)`, [username, null, teamCode, provider, providerId]);
    userId = result.lastInsertRowid;
    await q(`UPDATE teams SET created_by = COALESCE(created_by, ?) WHERE team_code = ?`, [userId, teamCode]);
  }
  return await getUserById(userId);
}

async function getUserById(id) {
  return (await q(isPostgres ? 'SELECT * FROM users WHERE id = $1' : 'SELECT * FROM users WHERE id = ?', [id]))[0];
}
async function getUserByUsername(username) {
  return (await q(isPostgres ? 'SELECT * FROM users WHERE username = $1' : 'SELECT * FROM users WHERE username = ?', [username]))[0];
}
async function getUserByProvider(provider, providerId) {
  return (await q(isPostgres ? 'SELECT * FROM users WHERE provider = $1 AND provider_id = $2' : 'SELECT * FROM users WHERE provider = ? AND provider_id = ?', [provider, providerId]))[0];
}
async function getTeam(teamCode) {
  return (await q(isPostgres ? 'SELECT * FROM teams WHERE team_code = $1' : 'SELECT * FROM teams WHERE team_code = ?', [teamCode]))[0];
}

function requireAuth(req, res, next) {
  if (!req.session.userId && !req.user?.id) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  if (!req.session.userId && req.user?.id) req.session.userId = req.user.id;
  next();
}

function publicConfig() {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
  return { vapidPublicKey, googleEnabled: !!process.env.GOOGLE_CLIENT_ID };
}

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

async function recalcStreak(userId) {
  const rows = await q(
    isPostgres
      ? `SELECT DISTINCT entry_date::text AS entry_date FROM pushups WHERE user_id = $1 ORDER BY entry_date ASC`
      : `SELECT DISTINCT entry_date FROM pushups WHERE user_id = ? ORDER BY entry_date ASC`,
    [userId]
  );
  const dates = rows.map(r => String(r.entry_date).slice(0, 10));
  if (!dates.length) {
    await q(isPostgres ? 'UPDATE users SET streak_count = 0, best_streak = 0 WHERE id = $1' : 'UPDATE users SET streak_count = 0, best_streak = 0 WHERE id = ?', [userId]);
    return { streakCount: 0, bestStreak: 0 };
  }
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let current = 1, best = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]);
    const cur = new Date(dates[i]);
    const diff = Math.round((cur - prev) / 86400000);
    if (diff === 1) current += 1;
    else current = 1;
    if (current > best) best = current;
  }
  let active = 0;
  const reversed = [...dates].reverse();
  if (reversed[0] === today || reversed[0] === yesterday) {
    active = 1;
    for (let i = 1; i < reversed.length; i++) {
      const newer = new Date(reversed[i - 1]);
      const older = new Date(reversed[i]);
      const diff = Math.round((newer - older) / 86400000);
      if (diff === 1) active += 1; else break;
    }
  }
  await q(isPostgres ? 'UPDATE users SET streak_count = $1, best_streak = $2 WHERE id = $3' : 'UPDATE users SET streak_count = ?, best_streak = ? WHERE id = ?', [active, best, userId]);
  return { streakCount: active, bestStreak: best };
}

async function buildDashboard(userId) {
  const me = await getUserById(userId);
  const team = await getTeam(me.team_code);
  const { year, month, weekStart } = getDateParts();
  const teamUsers = await q(
    isPostgres
      ? `SELECT id, username, weekly_goal, monthly_goal, yearly_goal, streak_count, best_streak FROM users WHERE team_code = $1 ORDER BY username ASC`
      : `SELECT id, username, weekly_goal, monthly_goal, yearly_goal, streak_count, best_streak FROM users WHERE team_code = ? ORDER BY username ASC`,
    [me.team_code]
  );
  const entries = await q(
    isPostgres
      ? `SELECT p.*, u.username FROM pushups p JOIN users u ON u.id = p.user_id WHERE u.team_code = $1 ORDER BY p.entry_date DESC, p.id DESC LIMIT 100`
      : `SELECT p.*, u.username FROM pushups p JOIN users u ON u.id = p.user_id WHERE u.team_code = ? ORDER BY p.entry_date DESC, p.id DESC LIMIT 100`,
    [me.team_code]
  );
  const summary = teamUsers.map(user => {
    const weekly = entries.filter(e => e.user_id === user.id && String(e.entry_date).slice(0,10) >= weekStart).reduce((a,b)=>a+Number(b.amount),0);
    const monthly = entries.filter(e => e.user_id === user.id && String(e.entry_date).slice(0,7) === `${year}-${month}`).reduce((a,b)=>a+Number(b.amount),0);
    const yearly = entries.filter(e => e.user_id === user.id && String(e.entry_date).slice(0,4) === String(year)).reduce((a,b)=>a+Number(b.amount),0);
    return {
      id: user.id,
      username: user.username,
      weekly,
      monthly,
      yearly,
      weeklyGoal: user.weekly_goal,
      monthlyGoal: user.monthly_goal,
      yearlyGoal: user.yearly_goal,
      streakCount: user.streak_count || 0,
      bestStreak: user.best_streak || 0
    };
  }).sort((a,b) => b.yearly - a.yearly || b.monthly - a.monthly || b.weekly - a.weekly || a.username.localeCompare(b.username));

  return {
    me: {
      id: me.id,
      username: me.username,
      teamCode: me.team_code,
      weeklyGoal: me.weekly_goal,
      monthlyGoal: me.monthly_goal,
      yearlyGoal: me.yearly_goal,
      streakCount: me.streak_count || 0,
      bestStreak: me.best_streak || 0,
      provider: me.provider
    },
    team: {
      teamCode: team?.team_code || me.team_code,
      teamName: team?.team_name || 'Mein Team',
      visibility: team?.visibility || 'private'
    },
    summary,
    entries
  };
}

async function emitTeamUpdate(teamCode, eventName = 'dashboard:update', extra = {}) {
  const member = await q(isPostgres ? 'SELECT id FROM users WHERE team_code = $1 LIMIT 1' : 'SELECT id FROM users WHERE team_code = ? LIMIT 1', [teamCode]);
  if (!member[0]) return;
  const dashboard = await buildDashboard(member[0].id);
  io.to(`team:${teamCode}`).emit(eventName, { ...dashboard, ...extra });
}

async function sendTeamPush(teamCode, title, body) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) return;
  const subs = await q(
    isPostgres
      ? `SELECT ps.id, ps.subscription_json FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE u.team_code = $1`
      : `SELECT ps.id, ps.subscription_json FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE u.team_code = ?`,
    [teamCode]
  );
  for (const sub of subs) {
    try {
      const parsed = typeof sub.subscription_json === 'string' ? JSON.parse(sub.subscription_json) : sub.subscription_json;
      await webpush.sendNotification(parsed, JSON.stringify({ title, body }));
    } catch {
      await q(isPostgres ? 'DELETE FROM push_subscriptions WHERE id = $1' : 'DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
    }
  }
}

configurePassport();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', async (_req, res) => res.json({ ok: true, database: isPostgres ? 'postgres' : 'sqlite' }));
app.get('/api/config', (_req, res) => res.json(publicConfig()));
app.get('/api/me', async (req, res) => {
  const userId = req.session.userId || req.user?.id;
  if (!userId) return res.json({ user: null, config: publicConfig() });
  const user = await getUserById(userId);
  if (!user) return res.json({ user: null, config: publicConfig() });
  res.json({
    user: {
      id: user.id,
      username: user.username,
      teamCode: user.team_code,
      weeklyGoal: user.weekly_goal,
      monthlyGoal: user.monthly_goal,
      yearlyGoal: user.yearly_goal,
      streakCount: user.streak_count || 0,
      bestStreak: user.best_streak || 0,
      provider: user.provider
    },
    config: publicConfig()
  });
});

app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const teamCodeInput = String(req.body.teamCode || '').trim().toUpperCase();
    const teamName = String(req.body.teamName || 'Mein Team').trim().slice(0, 50);
    if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort sind erforderlich.' });
    if (password.length < 4) return res.status(400).json({ error: 'Passwort muss mindestens 4 Zeichen haben.' });
    if (await getUserByUsername(username)) return res.status(400).json({ error: 'Benutzername existiert bereits.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const teamCode = teamCodeInput || makeTeamCode();
    let team = await getTeam(teamCode);
    if (!team) {
      await q(isPostgres ? 'INSERT INTO teams (team_code, team_name, visibility) VALUES ($1, $2, $3)' : 'INSERT INTO teams (team_code, team_name, visibility) VALUES (?, ?, ?)', [teamCode, teamName || 'Mein Team', 'private']);
      team = await getTeam(teamCode);
    }

    let userId;
    if (isPostgres) {
      const rows = await q(`INSERT INTO users (username, password_hash, team_code) VALUES ($1, $2, $3) RETURNING id`, [username, passwordHash, teamCode]);
      userId = rows[0].id;
      await q('UPDATE teams SET created_by = COALESCE(created_by, $1) WHERE team_code = $2', [userId, teamCode]);
    } else {
      const result = await q(`INSERT INTO users (username, password_hash, team_code) VALUES (?, ?, ?)`, [username, passwordHash, teamCode]);
      userId = result.lastInsertRowid;
      await q('UPDATE teams SET created_by = COALESCE(created_by, ?) WHERE team_code = ?', [userId, teamCode]);
    }

    req.session.userId = userId;
    res.json({ success: true, teamCode });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Registrierung fehlgeschlagen.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = await getUserByUsername(username);
    if (!user || !user.password_hash) return res.status(400).json({ error: 'Ungültige Zugangsdaten.' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Ungültige Zugangsdaten.' });
    req.session.userId = user.id;
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login fehlgeschlagen.' });
  }
});

app.get('/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/?oauth=google-not-configured');
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/?oauth=google-failed' }), (req, res) => {
  req.session.userId = req.user.id;
  res.redirect('/');
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

app.get('/api/dashboard', requireAuth, async (req, res) => res.json(await buildDashboard(req.session.userId || req.user.id)));

app.post('/api/goals', requireAuth, async (req, res) => {
  const weeklyGoal = Math.max(0, Number(req.body.weeklyGoal || 0));
  const monthlyGoal = Math.max(0, Number(req.body.monthlyGoal || 0));
  const yearlyGoal = Math.max(0, Number(req.body.yearlyGoal || 0));
  const userId = req.session.userId || req.user.id;
  await q(isPostgres ? 'UPDATE users SET weekly_goal = $1, monthly_goal = $2, yearly_goal = $3 WHERE id = $4' : 'UPDATE users SET weekly_goal = ?, monthly_goal = ?, yearly_goal = ? WHERE id = ?', [weeklyGoal, monthlyGoal, yearlyGoal, userId]);
  const me = await getUserById(userId);
  await emitTeamUpdate(me.team_code, 'dashboard:update', { toast: `${me.username} hat Ziele aktualisiert.` });
  res.json({ success: true });
});

app.post('/api/team', requireAuth, async (req, res) => {
  const userId = req.session.userId || req.user.id;
  const me = await getUserById(userId);
  const team = await getTeam(me.team_code);
  if (!team) return res.status(404).json({ error: 'Team nicht gefunden.' });
  if (team.created_by && Number(team.created_by) !== Number(userId)) return res.status(403).json({ error: 'Nur der Team-Ersteller kann das ändern.' });
  const teamName = String(req.body.teamName || team.team_name).trim().slice(0, 50) || 'Mein Team';
  const visibility = normalizeTeamVisibility(req.body.visibility);
  await q(isPostgres ? 'UPDATE teams SET team_name = $1, visibility = $2 WHERE team_code = $3' : 'UPDATE teams SET team_name = ?, visibility = ? WHERE team_code = ?', [teamName, visibility, me.team_code]);
  await emitTeamUpdate(me.team_code, 'dashboard:update', { toast: 'Team-Einstellungen gespeichert.' });
  res.json({ success: true });
});

app.post('/api/pushups', requireAuth, async (req, res) => {
  const amount = Math.max(1, Number(req.body.amount || 0));
  const entryDate = String(req.body.entryDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const note = String(req.body.note || '').slice(0, 140);
  const userId = req.session.userId || req.user.id;
  if (!amount) return res.status(400).json({ error: 'Bitte Anzahl angeben.' });
  await q(isPostgres ? 'INSERT INTO pushups (user_id, amount, entry_date, note) VALUES ($1, $2, $3, $4)' : 'INSERT INTO pushups (user_id, amount, entry_date, note) VALUES (?, ?, ?, ?)', [userId, amount, entryDate, note]);
  const streak = await recalcStreak(userId);
  const me = await getUserById(userId);
  await emitTeamUpdate(me.team_code, 'dashboard:update', { toast: `${me.username} hat ${amount} Push-Ups eingetragen.` });
  await sendTeamPush(me.team_code, 'Neuer Push-Up Eintrag', `${me.username} hat ${amount} Push-Ups eingetragen. Aktuelle Streak: ${streak.streakCount} Tage.`);
  res.json({ success: true, streak });
});

app.post('/api/push-subscribe', requireAuth, async (req, res) => {
  const userId = req.session.userId || req.user.id;
  const subscription = req.body.subscription;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Ungültige Subscription.' });
  const payload = JSON.stringify(subscription);
  if (isPostgres) {
    await q(`INSERT INTO push_subscriptions (user_id, endpoint, subscription_json) VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, subscription_json = EXCLUDED.subscription_json`, [userId, subscription.endpoint, payload]);
  } else {
    await q('INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, subscription_json) VALUES (?, ?, ?)', [userId, subscription.endpoint, payload]);
  }
  res.json({ success: true });
});

app.get('/api/export.xlsx', requireAuth, async (req, res) => {
  const userId = req.session.userId || req.user.id;
  const dashboard = await buildDashboard(userId);
  const workbook = new ExcelJS.Workbook();
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Name', key: 'username', width: 22 },
    { header: 'Woche', key: 'weekly', width: 12 },
    { header: 'Monat', key: 'monthly', width: 12 },
    { header: 'Jahr', key: 'yearly', width: 12 },
    { header: 'Streak', key: 'streakCount', width: 12 },
    { header: 'Beste Streak', key: 'bestStreak', width: 14 }
  ];
  dashboard.summary.forEach(r => summarySheet.addRow(r));

  const entrySheet = workbook.addWorksheet('Entries');
  entrySheet.columns = [
    { header: 'Benutzer', key: 'username', width: 22 },
    { header: 'Anzahl', key: 'amount', width: 12 },
    { header: 'Datum', key: 'entry_date', width: 16 },
    { header: 'Notiz', key: 'note', width: 36 }
  ];
  dashboard.entries.forEach(r => entrySheet.addRow({ username: r.username, amount: r.amount, entry_date: String(r.entry_date).slice(0, 10), note: r.note || '' }));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="pushup-export.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

io.on('connection', (socket) => {
  socket.on('team:join', (teamCode) => {
    if (teamCode) socket.join(`team:${String(teamCode).toUpperCase()}`);
  });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

(async () => {
  try {
    await initDb();
    server.listen(PORT, () => console.log(`Server läuft auf :${PORT}`));
  } catch (e) {
    console.error('DB init failed', e);
    process.exit(1);
  }
})();
