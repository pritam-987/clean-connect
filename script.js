'use strict';
/* CleanConnect frontend. Talks to server.js over /api. Roles are enforced by the server; the UI only mirrors them. */
const TOKEN_KEY = 'cleanconnect-token';
const DAY = 864e5, DEADLINE_DAYS = 3, HOT_DAYS = 30;
const STAGES = ['Pending Review', 'Assigned to Area Team', 'Cleanup In Progress', 'Cleanup Completed', 'Feedback Received'];
const CATS = ['Household garbage', 'Roadside dumping', 'Overflowing public bins', 'Market waste', 'Construction debris', 'Missed garbage collection', 'Other'];
const WARDS = ['Riverside', 'Old Market', 'Hillview'];
const TEAMS = WARDS.map((w, i) => ({ id: 't' + (i + 1), ward: w, name: w + ' Sanitation Team (sample)' }));

let state = { user: null, reports: [], error: '' }, view = 'home', openId = null;
const F = { q: '', ward: '', cat: '', st: '', pri: '', sort: 'new' };
const $ = s => document.querySelector(s);
const fmt = t => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const f1 = v => v == null ? '—' : v.toFixed(1);
const role = () => state.user ? state.user.role : 'guest';
const team = id => TEAMS.find(t => t.id === id);

/* Safe DOM builder: text is always added as text nodes, never as HTML. */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

/* ---------- API layer ---------- */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }, tok = localStorage.getItem(TOKEN_KEY);
  if (tok) headers.Authorization = 'Bearer ' + tok;
  let res;
  try { res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined }); }
  catch (e) { throw new Error('Cannot reach the server. Run "node server.js" and open http://localhost:3000.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
async function refresh() { // reload session and the report list from the server
  state.error = '';
  try {
    state.user = null;
    if (localStorage.getItem(TOKEN_KEY)) { try { state.user = await api('/me'); } catch (e) { localStorage.removeItem(TOKEN_KEY); } }
    state.reports = await api('/reports');
  } catch (e) { state.error = e.message; }
}
async function act(fn, okMsg) { try { await fn(); await refresh(); render(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message); } }

/* ---------- UI helpers ---------- */
let tt;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 3500); }
function ask(msg) {
  const d = $('#dlg');
  if (!d.showModal) return Promise.resolve(confirm(msg));
  $('#dlgMsg').textContent = msg; d.returnValue = ''; d.showModal();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}
function readImg(file) { // validates, then downsizes to a small JPEG data URL for upload
  return new Promise((ok, no) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return no('Use a JPG, PNG or WebP image.');
    if (file.size > 5e6) return no('Image must be under 5 MB.');
    const fr = new FileReader();
    fr.onload = () => { const im = new Image(); im.onload = () => {
      const s = Math.min(1, 800 / Math.max(im.width, im.height)), c = document.createElement('canvas');
      c.width = im.width * s; c.height = im.height * s; c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); ok(c.toDataURL('image/jpeg', .75));
    }; im.onerror = () => no('Could not read that image.'); im.src = fr.result; };
    fr.readAsDataURL(file);
  });
}
const photoEl = (src, alt) => src ? h('img', { src, alt, loading: 'lazy' }) : h('div', { class: 'ph' }, 'No photo');
const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
const badge = (txt, cls = '') => h('span', { class: 'badge ' + cls }, txt);
const statusBadge = r => badge(STAGES[r.stage], r.stage < 2 ? 'w' : '');
const overdue = r => r.stage < 3 && Date.now() - r.created > DEADLINE_DAYS * DAY;
const signInPrompt = msg => h('div', { class: 'card' }, h('p', {}, msg), h('button', { class: 'cta', onclick: () => nav('auth') }, 'Sign in'));

/* ---------- Metrics ---------- */
function suggestPriority(cat, desc) {
  if (/hospital|school|drain|medical|hazard|smell|fire|broken glass/i.test(desc)) return 'High';
  return ['Market waste', 'Overflowing public bins', 'Missed garbage collection', 'Construction debris'].includes(cat) ? 'Medium' : 'Low';
}
const placeKey = r => r.ward + '|' + r.location.toLowerCase().trim();
function hotspots() { // same ward + landmark text, 2+ reports in the window. A hint, not proof of one physical spot.
  const m = {};
  state.reports.filter(r => Date.now() - r.created < HOT_DAYS * DAY).forEach(r => (m[placeKey(r)] = m[placeKey(r)] || []).push(r));
  return Object.values(m).filter(l => l.length > 1).map(l => ({ ward: l[0].ward, loc: l[0].location, list: l, open: l.filter(r => r.stage < 3).length,
    repeat: l.some(a => l.some(b => b.completedAt && a.created > b.completedAt)) }));
}
function wardStats(rows) {
  const done = rows.filter(r => r.stage >= 3), fb = rows.filter(r => r.feedback);
  return { total: rows.length, pending: rows.length - done.length, done: done.length, confirmed: fb.length,
    time: avg(done.map(r => (r.completedAt - r.created) / DAY)), rate: rows.length ? done.length / rows.length * 100 : 0,
    sat: avg(fb.map(r => r.feedback.overall)), qual: avg(fb.map(r => r.feedback.quality)), tim: avg(fb.map(r => r.feedback.time)), fbPct: done.length ? fb.length / done.length * 100 : 0 };
}
const canWork = r => role() === 'admin' || (role() === 'team' && r.teamId === state.user.teamId);

/* ---------- Navigation ---------- */
function nav(v, id) { view = v; openId = id || null; render(); scrollTo(0, 0); $('#nav').classList.remove('open'); }
function render() {
  document.querySelectorAll('[data-v]').forEach(b => {
    b.setAttribute('aria-current', b.dataset.v === view || (view === 'detail' && b.dataset.v === 'explore') ? 'page' : 'false');
    b.hidden = !!b.dataset.roles && !b.dataset.roles.includes(role());
  });
  $('#who').textContent = state.user ? state.user.name + ' (' + state.user.role + ')' : '';
  $('#auth').textContent = state.user ? 'Sign out' : 'Sign in';
  const app = $('#app'); app.replaceChildren();
  if (state.error) { app.append(h('p', { class: 'note' }, state.error), h('button', { onclick: async () => { await refresh(); render(); } }, 'Try again')); return; }
  if (view === 'tasks' && !['team', 'admin'].includes(role())) view = 'home';
  ({ home: vHome, report: vReport, explore: vExplore, mine: vMine, area: vArea, tasks: vTasks, detail: vDetail, auth: vAuth }[view] || vHome)(app);
}

/* ---------- Views ---------- */
function reportCard(r) {
  const t = team(r.teamId);
  return h('article', { class: 'card rc', tabindex: 0, role: 'link', 'aria-label': 'Open ' + r.title, onclick: () => nav('detail', r.id), onkeydown: e => { if (e.key === 'Enter') nav('detail', r.id); } },
    photoEl(r.photo, ''), h('div', { class: 'row' }, statusBadge(r), overdue(r) && badge('Overdue', 'b'), badge(r.priority + ' priority')),
    h('h3', {}, r.title), h('span', { class: 'mute' }, r.id + ' · ' + r.category), h('span', {}, r.location + ', ' + r.ward),
    h('small', {}, fmt(r.created) + ' · ' + r.supportCount + ' supporting · ' + (t ? t.name : 'Unassigned')),
    r.possibleDuplicateOf && badge('Possible duplicate of ' + r.possibleDuplicateOf, 'w'));
}
function listInto(box, rows, empty) { box.replaceChildren(...(rows.length ? rows.map(reportCard) : [h('p', { class: 'card' }, empty)])); }

function vAuth(app) {
  let reg = false;
  const box = h('form', { class: 'card form narrow', novalidate: '' });
  function draw() {
    const name = h('input', { name: 'name', autocomplete: 'name' }), email = h('input', { name: 'email', type: 'email', autocomplete: 'email' }), pw = h('input', { name: 'password', type: 'password', autocomplete: reg ? 'new-password' : 'current-password' });
    const err = h('small', { class: 'err', role: 'alert' });
    box.replaceChildren(h('h1', {}, reg ? 'Create resident account' : 'Sign in'), reg && h('label', {}, 'Name', name), h('label', {}, 'Email', email), h('label', {}, reg ? 'Password (8+ characters)' : 'Password', pw), err,
      h('button', { class: 'cta' }, reg ? 'Create account' : 'Sign in'), h('button', { type: 'button', class: 'ghost', onclick: () => { reg = !reg; draw(); } }, reg ? 'I already have an account' : 'Create a resident account'),
      h('p', { class: 'mute' }, 'Team and admin accounts are created by the server on first start (passwords are printed in its console).'));
    box.onsubmit = async e => {
      e.preventDefault();
      try {
        const r = await api(reg ? '/register' : '/login', { method: 'POST', body: { name: name.value, email: email.value, password: pw.value } });
        localStorage.setItem(TOKEN_KEY, r.token); await refresh(); nav('home'); toast('Signed in as ' + r.user.name + '.');
      } catch (x) { err.textContent = x.message; }
    };
  }
  draw(); app.append(box);
}

function vHome(app) {
  const s = wardStats(state.reports), hs = hotspots();
  app.append(h('section', { class: 'hero' }, h('h1', {}, "Let's make our neighbourhood cleaner."),
    h('p', {}, 'Report uncollected garbage, track cleanup progress, and help improve waste collection in your area.'),
    h('div', { class: 'row' }, h('button', { class: 'cta', onclick: () => nav('report') }, 'Report Garbage'), h('button', { onclick: () => nav('explore') }, 'Explore Local Reports')),
    h('p', { class: 'mute' }, 'Report it. Track it. Clean it.')),
    h('div', { class: 'stats' }, [['Total reports', s.total], ['Pending reports', s.pending], ['Cleanups completed', s.done], ['Avg. reported resolution time', s.time == null ? '—' : f1(s.time) + ' days']]
      .map(([l, v]) => h('div', { class: 'card stat' }, h('b', {}, v), h('span', {}, l)))),
    h('p', { class: 'mute' }, 'Calculated from reports on this server. Team-recorded completions are not independent verification.'),
    h('h2', {}, 'How CleanConnect works'),
    h('div', { class: 'grid' }, ['Report a problem with a photo and location.', 'The responsible area team receives the task.', 'Cleanup is completed and documented.', 'Residents confirm and give feedback.']
      .map((t, i) => h('div', { class: 'card' }, h('b', {}, 'Step ' + (i + 1)), h('p', {}, t)))),
    h('h2', {}, 'Recurring hotspots'), hotspotList(hs));
}
function hotspotList(hs) {
  if (!hs.length) return h('p', { class: 'card' }, 'No recurring hotspots in the last ' + HOT_DAYS + ' days.');
  return h('div', { class: 'grid' }, hs.map(x => h('div', { class: 'card' }, h('h3', {}, x.loc), h('p', {}, x.ward + ' · ' + x.list.length + ' reports in ' + HOT_DAYS + ' days'),
    x.open ? badge(x.open + ' unresolved', 'w') : badge('All resolved'), ' ', x.repeat && badge('Repeat after cleanup', 'b'))));
}

function vReport(app) {
  if (role() !== 'resident') { app.append(h('h1', {}, 'Report garbage'), signInPrompt(role() === 'guest' ? 'Sign in with a resident account to submit a report.' : 'Only resident accounts can submit reports.')); return; }
  app.append($('#tReport').content.cloneNode(true));
  const f = $('#frm'); let photo = null;
  CATS.forEach(c => f.category.append(h('option', { value: c }, c))); WARDS.forEach(w => f.ward.append(h('option', { value: w }, w)));
  f.category.prepend(h('option', { value: '' }, 'Select…')); f.ward.prepend(h('option', { value: '' }, 'Select…')); f.category.value = f.ward.value = '';
  const setErr = (k, m) => { f.querySelector('[data-for="' + k + '"]').textContent = m || ''; };
  f.photo.onchange = async () => {
    photo = null; $('#prev').hidden = true; setErr('photo');
    if (!f.photo.files[0]) return;
    try { photo = await readImg(f.photo.files[0]); $('#prev').src = photo; $('#prev').hidden = false; } catch (m) { setErr('photo', m); f.photo.value = ''; }
  };
  $('#geo').onclick = () => { // location is requested only on click
    if (!navigator.geolocation) return setErr('coords', 'Location is not available. Enter it manually.');
    navigator.geolocation.getCurrentPosition(p => { f.coords.value = p.coords.latitude.toFixed(5) + ', ' + p.coords.longitude.toFixed(5); setErr('coords'); },
      () => setErr('coords', 'Location access was denied. Enter it manually or leave blank.'));
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const v = n => f.elements[n].value.trim(), er = {};
    if (v('title').length < 5) er.title = 'Enter a title of at least 5 characters.';
    if (!v('category')) er.category = 'Choose a category.';
    if (v('description').length < 10) er.description = 'Describe the problem in at least 10 characters.';
    if (!v('location')) er.location = 'Add a location or landmark.';
    if (!v('ward')) er.ward = 'Choose a ward.';
    if (!photo) er.photo = 'Add a photograph.';
    if (v('coords') && !/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(v('coords'))) er.coords = 'Use the format: latitude, longitude.';
    if (!f.consent.checked) er.consent = 'Consent is required to submit.';
    ['title', 'category', 'description', 'location', 'ward', 'photo', 'coords', 'consent'].forEach(k => setErr(k, er[k]));
    if (Object.keys(er).length) return;
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const r = await api('/reports', { method: 'POST', body: { title: v('title'), category: v('category'), description: v('description'), location: v('location'), ward: v('ward'), coords: v('coords'), photo, consent: true } });
      await refresh(); nav('detail', r.id);
      toast(r.teamId ? 'Report ' + r.id + ' submitted and assigned to ' + team(r.teamId).name + '.' : 'Report ' + r.id + ' submitted. No team covers this ward yet.');
    } catch (x) { btn.disabled = false; toast(x.message); }
  };
}

/* Shared search + filter list for Explore and Team Tasks */
function browse(app, title, rows, tasks, before) {
  const PLURAL = { Ward: 'wards', Priority: 'priorities', Category: 'categories', Status: 'statuses' };
  const bar = h('div', { class: 'bar' },
    h('input', { type: 'search', 'aria-label': 'Search reports', placeholder: 'Search title, description, location', value: F.q, oninput: e => { F.q = e.target.value; draw(); } }),
    sel('Ward', 'ward', WARDS), tasks ? sel('Priority', 'pri', ['Low', 'Medium', 'High']) : sel('Category', 'cat', CATS), sel('Status', 'st', STAGES.map((s, i) => [i, s])),
    h('select', { 'aria-label': 'Sort', onchange: e => { F.sort = e.target.value; draw(); } }, h('option', { value: 'new' }, 'Newest first'), h('option', { value: 'old', selected: F.sort === 'old' }, 'Oldest first')));
  function sel(label, key, opts) {
    return h('select', { 'aria-label': label, onchange: e => { F[key] = e.target.value; draw(); } }, h('option', { value: '' }, 'All ' + PLURAL[label]),
      opts.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(F[key]) === String(v) }, t); }));
  }
  const box = h('div', { class: 'grid' });
  function draw() {
    const q = F.q.toLowerCase();
    const out = rows().filter(r => (!q || (r.title + r.description + r.location).toLowerCase().includes(q)) && (!F.ward || r.ward === F.ward) && (tasks || !F.cat || r.category === F.cat)
      && (F.st === '' || r.stage === +F.st) && (!tasks || !F.pri || r.priority === F.pri));
    out.sort((a, b) => F.sort === 'new' ? b.created - a.created : a.created - b.created);
    listInto(box, out, 'No reports match these filters. Clear a filter or submit a new report.');
  }
  app.append(h('h1', {}, title), before, bar, box); draw();
}
function vExplore(app) { browse(app, 'Explore reports', () => state.reports, false); }
function vTasks(app) {
  const rows = () => state.reports.filter(r => role() === 'admin' || r.teamId === state.user.teamId), mine = rows(), n = s => mine.filter(s).length;
  const before = [h('p', { class: 'note' }, 'Simulated workflow: status changes are recorded on this server, but no real workers or departments are contacted. "Overdue" = open longer than ' + DEADLINE_DAYS + ' days.'),
    h('div', { class: 'stats' }, [['Assigned', mine.length], ['Pending', n(r => r.stage <= 1)], ['In progress', n(r => r.stage === 2)], ['Completed', n(r => r.stage >= 3)], ['Overdue', n(overdue)]]
      .map(([l, v]) => h('div', { class: 'card stat' }, h('b', {}, v), h('span', {}, l))))];
  browse(app, role() === 'admin' ? 'All tasks' : (team(state.user.teamId) || { name: 'Tasks' }).name, rows, true, before);
}
function vMine(app) {
  app.append(h('h1', {}, 'My reports'));
  if (role() === 'guest') { app.append(signInPrompt('Sign in to see the reports you submitted.')); return; }
  const box = h('div', { class: 'grid' }); app.append(box);
  listInto(box, state.reports.filter(r => r.mine), 'You have not reported anything yet. Use "Report Garbage" to start.');
}

function vDetail(app) {
  const r = state.reports.find(x => x.id === openId);
  if (!r) { app.append(h('p', { class: 'card' }, 'That report was not found.'), h('button', { onclick: () => nav('explore') }, 'Back to reports')); return; }
  const t = team(r.teamId);
  app.append(h('button', { class: 'ghost', onclick: () => nav('explore') }, '← All reports'), h('h1', {}, r.title),
    h('div', { class: 'row' }, statusBadge(r), badge(r.priority + ' priority'), overdue(r) && badge('Overdue', 'b'), r.possibleDuplicateOf && badge('Possible duplicate of ' + r.possibleDuplicateOf, 'w')),
    h('ol', { class: 'track', 'aria-label': 'Progress' }, STAGES.map((s, i) => h('li', { class: i <= r.stage ? 'done' : '', 'aria-current': i === r.stage ? 'step' : null }, s))),
    h('p', { class: 'note' }, r.stage === 3 ? 'Marked completed by the team. Not yet confirmed by the resident.' : r.stage === 4 ? 'Completion confirmed by the resident.' : 'Completion has not been recorded.'),
    h('div', { class: 'card' }, h('p', {}, r.description), h('p', { class: 'mute' }, r.id + ' · ' + r.category + ' · ' + r.location + ', ' + r.ward + (r.coords ? ' · ' + r.coords : '') + ' · ' + fmt(r.created)),
      h('p', { class: 'mute' }, 'Team: ' + (t ? t.name : 'Unassigned. No team is mapped to this ward.')),
      h('div', { class: 'pair' }, h('figure', {}, photoEl(r.photo, 'Before cleanup'), h('small', {}, 'Before')), r.afterPhoto && h('figure', {}, photoEl(r.afterPhoto, 'After cleanup'), h('small', {}, 'After (team-uploaded, not independent proof)'))),
      h('button', { disabled: r.supportedByMe || role() !== 'resident' ? '' : null, title: role() === 'resident' ? '' : 'Sign in as a resident to support', onclick: () => act(() => api('/reports/' + r.id + '/support', { method: 'POST' }), 'Thanks. Your support was recorded.') },
        r.supportedByMe ? 'You supported this (' + r.supportCount + ')' : 'Support this report (' + r.supportCount + ')')),
    workPanel(r), feedbackPanel(r),
    h('h2', {}, 'Activity'), h('ul', { class: 'tl' }, r.timeline.map(e => h('li', {}, h('b', {}, e.from == null ? 'Submitted' : STAGES[e.from] + ' → ' + STAGES[e.to]), h('br'), h('small', {}, fmt(e.at) + ' · ' + e.by + (e.note ? ' · ' + e.note : ''))))),
    r.notes.length > 0 && [h('h2', {}, 'Work notes'), r.notes.map(n => h('p', { class: 'card' }, n.text, h('br'), h('small', {}, fmt(n.at) + ' · ' + n.by)))]);
}

async function changeStatus(r, to, note, afterPhoto) {
  if (!await ask('Change status to "' + STAGES[to] + '"? (Simulated: nobody is notified.)')) return;
  act(() => api('/reports/' + r.id + '/status', { method: 'POST', body: { to, note: note || undefined, afterPhoto: afterPhoto || undefined } }), 'Status updated to ' + STAGES[to] + '.');
}
function workPanel(r) {
  if (!canWork(r)) return null;
  const box = h('div', { class: 'card form' }, h('h2', {}, role() === 'admin' ? 'Admin and team actions' : 'Team actions'));
  if (role() === 'admin') { // admins review priority and (re)assign teams
    box.append(h('label', {}, 'Priority (suggested: ' + suggestPriority(r.category, r.description) + ')', h('select', { onchange: e => act(() => api('/reports/' + r.id, { method: 'PATCH', body: { priority: e.target.value } }), 'Priority updated.') },
      ['Low', 'Medium', 'High'].map(p => h('option', { selected: p === r.priority }, p)))),
      h('label', {}, 'Team', h('select', { onchange: e => e.target.value && act(() => api('/reports/' + r.id, { method: 'PATCH', body: { teamId: e.target.value } }), 'Team assigned.') },
        h('option', { value: '' }, 'Assign team…'), TEAMS.map(x => h('option', { value: x.id, selected: x.id === r.teamId }, x.name)))));
  }
  if (r.stage === 1 || r.stage === 2) {
    const note = h('textarea', { rows: 2, 'aria-label': 'Work note', placeholder: 'Work note (optional)', maxlength: 300 }), pic = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'After-cleanup photo' }), err = h('small', { class: 'err' });
    if (r.stage === 1) box.append(note, h('button', { class: 'cta', onclick: () => changeStatus(r, 2, note.value.trim()) }, 'Accept and start cleanup'));
    else box.append(note, h('label', {}, 'After-cleanup photo', pic), err, h('button', { class: 'cta', onclick: async () => {
      let after = null; try { if (pic.files[0]) after = await readImg(pic.files[0]); } catch (m) { err.textContent = m; return; }
      changeStatus(r, 3, note.value.trim(), after); } }, 'Mark cleanup completed'));
  } else box.append(h('p', { class: 'mute' }, r.stage === 0 ? 'Pending review. An admin can assign a team to start the workflow.' : 'No further team actions.'));
  return box;
}

function feedbackPanel(r) {
  if (r.feedback) return h('div', { class: 'card' }, h('h2', {}, 'Resident feedback'), h('p', {}, 'Overall ' + stars(r.feedback.overall) + ' · Timeliness ' + stars(r.feedback.time) + ' · Quality ' + stars(r.feedback.quality)), r.feedback.text && h('p', {}, r.feedback.text));
  if (r.stage !== 3) return null;
  if (!r.mine) return h('p', { class: 'mute' }, 'Waiting for the original reporter to confirm and rate this cleanup.');
  const sels = ['overall', 'time', 'quality'].map(k => h('select', { name: k }, [5, 4, 3, 2, 1].map(n => h('option', { value: n }, stars(n))))), txt = h('textarea', { rows: 2, maxlength: 300, 'aria-label': 'Written feedback' });
  return h('form', { class: 'card form', onsubmit: e => { e.preventDefault();
    act(() => api('/reports/' + r.id + '/feedback', { method: 'POST', body: { overall: +sels[0].value, time: +sels[1].value, quality: +sels[2].value, text: txt.value.trim() } }), 'Thanks. Feedback recorded (not verified evidence).'); } },
    h('h2', {}, 'Confirm and rate this cleanup'), h('label', {}, 'Overall', sels[0]), h('label', {}, 'Timeliness', sels[1]), h('label', {}, 'Cleanup quality', sels[2]),
    h('label', {}, 'Comments (optional)', txt), h('button', { class: 'cta' }, 'Submit feedback'));
}

function vArea(app) {
  const defs = ['Resolution rate = completed reports ÷ all reports × 100. Completed means recorded by the team; resident-confirmed counts are shown separately.',
    'Average resolution time = mean days from submission to recorded completion, completed reports only.', 'Feedback rate = reports with resident feedback ÷ completed reports × 100.', 'Ratings measure service delivered by an area team, not individuals. They are not verified evidence of real performance.'];
  const rows = WARDS.map(w => [w, wardStats(state.reports.filter(r => r.ward === w))]);
  app.append(h('h1', {}, 'Area dashboard'), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Area', 'Reports', 'Pending', 'Completed', 'Confirmed', 'Avg. days', 'Resolved', 'Satisfaction', 'Quality', 'Timeliness', 'Feedback rate'].map(x => h('th', { scope: 'col' }, x)))),
    h('tbody', {}, rows.map(([w, s]) => h('tr', {}, h('th', { scope: 'row' }, w), h('td', {}, s.total), h('td', {}, s.pending), h('td', {}, s.done), h('td', {}, s.confirmed), h('td', {}, f1(s.time)),
      h('td', {}, Math.round(s.rate) + '%', h('div', { class: 'meter' }, h('i', { style: 'width:' + s.rate + '%' }))), h('td', {}, f1(s.sat)), h('td', {}, f1(s.qual)), h('td', {}, f1(s.tim)), h('td', {}, Math.round(s.fbPct) + '%')))))),
    h('h2', {}, 'Recurring hotspots'), hotspotList(hotspots()), h('h2', {}, 'Metric definitions'), h('ul', {}, defs.map(d => h('li', {}, d))));
}

/* ---------- Setup ---------- */
async function init() {
  document.querySelectorAll('[data-v]').forEach(b => b.onclick = () => nav(b.dataset.v));
  $('#auth').onclick = async () => { if (state.user) { localStorage.removeItem(TOKEN_KEY); await refresh(); nav('home'); toast('Signed out.'); } else nav('auth'); };
  $('#menu').onclick = () => { const o = $('#nav').classList.toggle('open'); $('#menu').setAttribute('aria-expanded', o); };
  await refresh(); render();
}
init();
