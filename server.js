'use strict';
/* CleanConnect backend. Node 18+, no npm install. Run: node server.js
   Stores data in data.json and photos in uploads/. Roles are enforced here, not in the browser.
   This is a small-scale starter, not a hardened municipal system (see README). */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, DIR = __dirname, DB_FILE = path.join(DIR, 'data.json'), UP = path.join(DIR, 'uploads');
const STAGES = ['Pending Review', 'Assigned to Area Team', 'Cleanup In Progress', 'Cleanup Completed', 'Feedback Received'];
const CATS = ['Household garbage', 'Roadside dumping', 'Overflowing public bins', 'Market waste', 'Construction debris', 'Missed garbage collection', 'Other'];
const WARDS = ['Riverside', 'Old Market', 'Hillview'];
const TEAMS = WARDS.map((w, i) => ({ id: 't' + (i + 1), ward: w, name: w + ' Sanitation Team (sample)' }));
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/script.js': 'script.js' };
const MIME = { html: 'text/html', css: 'text/css', js: 'text/javascript', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/* ---------- storage (atomic JSON file) ---------- */
fs.mkdirSync(UP, { recursive: true });
const team = id => TEAMS.find(t => t.id === id);
let db = load();
function load() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {
      const bak = DB_FILE + '.corrupt-' + Date.now(); fs.renameSync(DB_FILE, bak); // never overwrite unreadable data
      console.error('data.json could not be read. Saved a copy as ' + path.basename(bak) + ' and starting fresh.');
    }
  }
  const d = { secret: crypto.randomBytes(32).toString('hex'), users: [], reports: [] };
  // First run: create admin and one account per team with random passwords, printed once.
  [['admin', 'admin@demo.local', null], ...TEAMS.map(t => ['team', t.id + '@demo.local', t.id])].forEach(([role, email, teamId]) => {
    const pw = crypto.randomBytes(6).toString('hex');
    d.users.push(mkUser(role === 'admin' ? 'Administrator' : team(teamId).name, email, pw, role, teamId));
    console.log('Created ' + role + ' account  ' + email + '  password: ' + pw);
  });
  fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 1)); return d;
}
function save() { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }

/* ---------- auth: scrypt passwords + HMAC-signed tokens ---------- */
function mkUser(name, email, pw, role, teamId = null) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomUUID(), name, email: email.toLowerCase(), salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex'), role, teamId };
}
function checkPw(u, pw) {
  const a = Buffer.from(crypto.scryptSync(pw, u.salt, 32).toString('hex')), b = Buffer.from(u.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', db.secret).update(b).digest('base64url'); };
function verify(tok) {
  const [b, s] = String(tok || '').split('.');
  if (!b || !s) return null;
  const ok = crypto.createHmac('sha256', db.secret).update(b).digest('base64url');
  if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? db.users.find(u => u.id === p.id) || null : null; } catch (e) { return null; }
}
const tries = {}; // naive login rate limit: 10 FAILED attempts / 15 min / IP
const recentFails = ip => (tries[ip] = (tries[ip] || []).filter(x => Date.now() - x < 9e5));

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (c, m) => { throw new HttpError(c, m); };
function str(v, min, max, name) { v = typeof v === 'string' ? v.trim() : ''; if (v.length < min || v.length > max) fail(400, name + ' must be ' + min + '-' + max + ' characters.'); return v; }
function body(req) {
  return new Promise((ok, no) => { let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > 6e6) { no(new HttpError(413, 'Request too large.')); req.destroy(); } else c.push(d); });
    req.on('end', () => { try { ok(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch (e) { no(new HttpError(400, 'Invalid JSON.')); } }); });
}
function savePhoto(data) { // data URL -> file; checks type, size and magic bytes
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data || '');
  if (!m) fail(400, 'Photo must be a JPG, PNG or WebP data URL.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2e6) fail(400, 'Photo must be under 2 MB.');
  const magic = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47], webp: [0x52, 0x49, 0x46, 0x46] }[m[1]];
  if (!magic.every((b, i) => buf[i] === b)) fail(400, 'Photo content does not match its type.');
  const name = crypto.randomBytes(16).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UP, name), buf); return '/uploads/' + name;
}
function suggestPriority(cat, desc) {
  if (/hospital|school|drain|medical|hazard|smell|fire|broken glass/i.test(desc)) return 'High';
  return ['Market waste', 'Overflowing public bins', 'Missed garbage collection', 'Construction debris'].includes(cat) ? 'Medium' : 'Low';
}
const placeKey = r => r.ward + '|' + r.location.toLowerCase().trim();
function view(r, u) { // public shape: never exposes owner id or emails
  const d = db.reports.find(o => o.id !== r.id && o.stage < 3 && o.created < r.created && placeKey(o) === placeKey(r) && o.category === r.category);
  const { owner, supports, ...rest } = r;
  return { ...rest, stageName: STAGES[r.stage], supportCount: supports.length, supportedByMe: !!u && supports.includes(u.id), mine: !!u && owner === u.id, possibleDuplicateOf: d ? d.id : null };
}
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
function stats(rows) {
  const done = rows.filter(r => r.stage >= 3), fb = rows.filter(r => r.feedback);
  return { total: rows.length, pending: rows.length - done.length, completed: done.length, residentConfirmed: fb.length,
    avgResolutionDays: avg(done.map(r => (r.completedAt - r.created) / 864e5)), resolutionRate: rows.length ? done.length / rows.length * 100 : 0,
    satisfaction: avg(fb.map(r => r.feedback.overall)), quality: avg(fb.map(r => r.feedback.quality)), timeliness: avg(fb.map(r => r.feedback.time)),
    feedbackRate: done.length ? fb.length / done.length * 100 : 0 };
}
function log(r, to, u, note) { r.timeline.push({ from: r.stage, to, at: Date.now(), by: u.role + ':' + u.name, note: note || '' }); r.stage = to; if (to === 3) r.completedAt = Date.now(); }
const need = (u, ...roles) => { if (!u) fail(401, 'Sign in required.'); if (!roles.includes(u.role)) fail(403, 'Your role cannot do this.'); };
const getReport = id => db.reports.find(r => r.id === id) || fail(404, 'Report not found.');
const canWork = (u, r) => u.role === 'admin' || (u.role === 'team' && u.teamId === r.teamId);

/* ---------- API ---------- */
async function api(req, res, url, u) {
  const m = req.method, p = url.pathname, q = url.searchParams;
  let x;
  if (m === 'POST' && p === '/api/register') {
    const b = await body(req), email = str(b.email, 5, 100, 'Email').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Enter a valid email.');
    if (db.users.some(o => o.email === email)) fail(409, 'That email is already registered.');
    const nu = mkUser(str(b.name, 2, 60, 'Name'), email, str(b.password, 8, 100, 'Password'), 'resident'); db.users.push(nu); save();
    return { token: sign({ id: nu.id, exp: Date.now() + 6048e5 }), user: { name: nu.name, role: nu.role } };
  }
  if (m === 'POST' && p === '/api/login') {
    const ip = req.socket.remoteAddress;
    if (recentFails(ip).length >= 10) fail(429, 'Too many failed attempts. Try again in 15 minutes.');
    const b = await body(req), lu = db.users.find(o => o.email === String(b.email || '').toLowerCase());
    if (!lu || !checkPw(lu, String(b.password || ''))) { tries[ip].push(Date.now()); fail(401, 'Wrong email or password.'); }
    return { token: sign({ id: lu.id, exp: Date.now() + 6048e5 }), user: { name: lu.name, role: lu.role, teamId: lu.teamId } };
  }
  if (m === 'GET' && p === '/api/me') { need(u, 'resident', 'team', 'admin'); return { name: u.name, role: u.role, teamId: u.teamId }; }
  if (m === 'GET' && p === '/api/meta') return { stages: STAGES, categories: CATS, wards: WARDS, teams: TEAMS };

  if (m === 'GET' && p === '/api/reports') { // public list with filters
    const s = (q.get('q') || '').toLowerCase();
    let rows = db.reports.filter(r => (!s || (r.title + r.description + r.location).toLowerCase().includes(s)) && (!q.get('ward') || r.ward === q.get('ward')) &&
      (!q.get('category') || r.category === q.get('category')) && (!q.get('status') || r.stage === +q.get('status')) && (q.get('mine') !== '1' || (u && r.owner === u.id)) &&
      (q.get('team') !== '1' || (u && (u.role === 'admin' || r.teamId === u.teamId))));
    rows.sort((a, b) => q.get('sort') === 'old' ? a.created - b.created : b.created - a.created);
    return rows.map(r => view(r, u));
  }
  if (m === 'POST' && p === '/api/reports') {
    need(u, 'resident'); const b = await body(req);
    if (b.consent !== true) fail(400, 'Consent is required.');
    const category = CATS.includes(b.category) ? b.category : fail(400, 'Choose a valid category.'), ward = WARDS.includes(b.ward) ? b.ward : fail(400, 'Choose a valid ward.');
    const coords = String(b.coords || '').trim(); if (coords && !/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(coords)) fail(400, 'Coordinates must be "lat, lng".');
    const description = str(b.description, 10, 500, 'Description'), t = TEAMS.find(z => z.ward === ward);
    const r = { id: 'CC-' + (Math.max(1000, ...db.reports.map(z => +z.id.slice(3) || 0)) + 1), title: str(b.title, 5, 80, 'Title'), category, description, location: str(b.location, 2, 80, 'Location'),
      ward, coords, photo: savePhoto(b.photo), afterPhoto: null, owner: u.id, created: Date.now(), stage: 0, priority: suggestPriority(category, description), teamId: t ? t.id : null,
      supports: [], notes: [], completedAt: null, feedback: null, timeline: [{ from: null, to: 0, at: Date.now(), by: 'resident:' + u.name, note: '' }] };
    db.reports.unshift(r); if (t) log(r, 1, { role: 'system', name: 'auto' }, 'Auto-assigned by ward'); save(); return view(r, u);
  }
  if ((x = /^\/api\/reports\/(CC-\d+)(\/\w+)?$/.exec(p))) {
    const r = getReport(x[1]), sub = x[2];
    if (m === 'GET' && !sub) return view(r, u);
    if (m === 'POST' && sub === '/support') { // one support per account
      need(u, 'resident'); if (r.supports.includes(u.id)) fail(409, 'You already supported this report.'); r.supports.push(u.id); save(); return view(r, u);
    }
    if (m === 'POST' && sub === '/status') { // team/admin: 1->2 start, 2->3 complete (feedback moves 3->4)
      need(u, 'team', 'admin'); if (!canWork(u, r)) fail(403, 'This report belongs to another team.');
      const b = await body(req), to = +b.to; if (!((r.stage === 1 && to === 2) || (r.stage === 2 && to === 3))) fail(409, 'Invalid status change from ' + STAGES[r.stage] + '.');
      if (b.note) r.notes.push({ text: str(b.note, 1, 300, 'Note'), at: Date.now(), by: u.name });
      if (to === 3 && b.afterPhoto) r.afterPhoto = savePhoto(b.afterPhoto);
      log(r, to, u, b.note ? 'See work note' : ''); save(); return view(r, u);
    }
    if (m === 'PATCH' && !sub) { // admin: priority review and (re)assignment
      need(u, 'admin'); const b = await body(req);
      if (b.priority !== undefined) r.priority = ['Low', 'Medium', 'High'].includes(b.priority) ? b.priority : fail(400, 'Invalid priority.');
      if (b.teamId !== undefined) { team(b.teamId) || fail(400, 'Unknown team.'); r.teamId = b.teamId; if (r.stage === 0) log(r, 1, u, 'Assigned by admin'); }
      save(); return view(r, u);
    }
    if (m === 'POST' && sub === '/feedback') {
      need(u, 'resident'); if (r.owner !== u.id) fail(403, 'Only the original reporter can rate this cleanup.');
      if (r.feedback) fail(409, 'Feedback was already submitted.'); if (r.stage !== 3) fail(409, 'Feedback opens after the team marks the cleanup completed.');
      const b = await body(req), n = v => Number.isInteger(v) && v >= 1 && v <= 5 ? v : fail(400, 'Ratings must be 1 to 5.');
      r.feedback = { overall: n(b.overall), time: n(b.time), quality: n(b.quality), text: b.text ? str(b.text, 1, 300, 'Comment') : '' }; log(r, 4, u, 'Feedback submitted'); save(); return view(r, u);
    }
  }
  if (m === 'GET' && p === '/api/stats') return { areas: WARDS.map(w => ({ ward: w, ...stats(db.reports.filter(r => r.ward === w)) })), overall: stats(db.reports) };
  if (m === 'GET' && p === '/api/hotspots') { // same ward + landmark text, 2+ reports in window; a hint, not proof of one physical spot
    const days = Math.min(+q.get('days') || 30, 365), g = {};
    db.reports.filter(r => Date.now() - r.created < days * 864e5).forEach(r => (g[placeKey(r)] = g[placeKey(r)] || []).push(r));
    return Object.values(g).filter(l => l.length > 1).map(l => ({ ward: l[0].ward, location: l[0].location, reports: l.map(r => r.id), unresolved: l.filter(r => r.stage < 3).length,
      repeatAfterCleanup: l.some(a => l.some(b => b.completedAt && a.created > b.completedAt)) }));
  }
  fail(404, 'Unknown endpoint.');
}

/* ---------- server ---------- */
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  const send = (c, o, t = 'application/json', extra = {}) => { res.writeHead(c, { 'Content-Type': t, 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(t === 'application/json' ? JSON.stringify(o) : o); };
  try {
    if (p.startsWith('/api/')) {
      const u = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
      return send(200, await api(req, res, url, u), 'application/json', { 'Cache-Control': 'no-store' });
    }
    const up = /^\/uploads\/([a-f0-9]{32}\.(jpg|png|webp))$/.exec(p);
    const file = up ? path.join(UP, up[1]) : STATIC[p] && path.join(DIR, STATIC[p]);
    if (!file || !fs.existsSync(file)) return send(404, { error: 'Not found.' });
    send(200, fs.readFileSync(file), MIME[file.split('.').pop()]);
  } catch (e) {
    if (e instanceof HttpError) return send(e.code, { error: e.message });
    console.error(e); send(500, { error: 'Server error.' });
  }
}).on('error', e => { console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is already in use. Try: PORT=3001 node server.js (Windows cmd: set PORT=3001 && node server.js)' : e); process.exit(1); })
  .listen(PORT, process.env.HOST || '127.0.0.1', () => console.log('CleanConnect on http://localhost:' + PORT + ' (set HOST=0.0.0.0 to allow other devices)'));
