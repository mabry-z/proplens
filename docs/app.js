// PropLens — NFL player prop trends. Reads everything from Supabase with the public (read-only) key.
const SUPABASE_URL = 'https://yxdhnmvksbwfdhrmtvpf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_CcKl0p60prPvozy2uY81LA_HoYlgRPd';

const BOOKS = { prizepicks: 'PrizePicks', underdog: 'Underdog', pick6: 'Pick6' };
const MARKETS = {
  player_pass_yds: { label: 'Pass Yds', long: 'Passing Yards', val: g => g.pass_yds, rank: 'pass_yds' },
  player_rush_yds: { label: 'Rush Yds', long: 'Rushing Yards', val: g => g.rush_yds, rank: 'rush_yds' },
  player_reception_yds: { label: 'Rec Yds', long: 'Receiving Yards', val: g => g.rec_yds, rank: 'rec_yds' },
  player_receptions: { label: 'Receptions', long: 'Receptions', val: g => g.rec, rank: 'rec' },
  player_rush_reception_yds: {
    label: 'Rush+Rec', long: 'Rush + Rec Yards', rank: 'rush_yds',
    val: g => (g.rush_yds == null && g.rec_yds == null) ? null : (Number(g.rush_yds) || 0) + (Number(g.rec_yds) || 0),
  },
};
const TEAMS = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills', CAR: 'Carolina Panthers',
  CHI: 'Chicago Bears', CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns', DAL: 'Dallas Cowboys', DEN: 'Denver Broncos',
  DET: 'Detroit Lions', GB: 'Green Bay Packers', HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars',
  KC: 'Kansas City Chiefs', LV: 'Las Vegas Raiders', LAC: 'Los Angeles Chargers', LA: 'Los Angeles Rams', MIA: 'Miami Dolphins',
  MIN: 'Minnesota Vikings', NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants', NYJ: 'New York Jets',
  PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers', SF: 'San Francisco 49ers', SEA: 'Seattle Seahawks',
  TB: 'Tampa Bay Buccaneers', TEN: 'Tennessee Titans', WAS: 'Washington Commanders',
};
// Stat choices for a player with no line today, by position.
const POS_MARKETS = {
  QB: ['player_pass_yds', 'player_rush_yds'],
  RB: ['player_rush_yds', 'player_rush_reception_yds', 'player_reception_yds', 'player_receptions'],
  FB: ['player_rush_yds', 'player_reception_yds', 'player_receptions'],
  WR: ['player_reception_yds', 'player_receptions'],
  TE: ['player_reception_yds', 'player_receptions'],
};
// Defense-vs-position groups only cover QB/RB/WR/TE.
const posGroup = p => p === 'FB' ? 'RB' : ['QB', 'RB', 'WR', 'TE'].includes(p) ? p : 'WR';
// Must match the schedule in .github/workflows/sync-lines.yml (UTC).
const PULLS = [{ dow: 4, h: 17 }, { dow: 0, h: 12 }, { dow: 1, h: 17 }];
const C = { more: '#4BF08F', less: '#FF7A66', warn: '#F5C451', muted: '#9AA3AF' };

// ---------- tiny helpers ----------
const $view = document.getElementById('view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ordinal = n => { const t = n % 100, u = n % 10; return n + ((t > 10 && t < 14) || u > 3 || u === 0 ? 'th' : ['th', 'st', 'nd', 'rd'][u]); };
const fmt1 = v => (v == null || isNaN(v)) ? '–' : Number(v).toFixed(1);
const store = {
  get(k, d) { try { const v = localStorage.getItem('proplens.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('proplens.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const timeFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const kickFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

async function q(table, params) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
    Object.entries({ ...params, limit: 1000, offset }).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url, { headers: { apikey: SUPABASE_KEY } });
    if (!r.ok) throw new Error(`${table}: ${r.status}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
async function qIn(table, col, ids, params, size = 60) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size).map(id => `"${id}"`).join(',');
    out.push(...await q(table, { ...params, [col]: `in.(${chunk})` }));
  }
  return out;
}

// ---------- state ----------
const S = {
  book: store.get('book', 'prizepicks'),
  n: store.get('n', 10),
  minHit: store.get('minHit', 50),
  stat: 'all',
  sort: store.get('sort', 'edge'),
  picks: store.get('picks', {}),   // key -> { side, name, market, line, book, pid }
  query: '',                         // search box text
  filter: null,                      // { type: 'team' | 'game', value, label }
  remote: { q: '', rows: [] },       // player search results from the database
  custom: {},                        // "pid|market" -> custom line on the player page
  data: null,
};
const save = () => { store.set('book', S.book); store.set('n', S.n); store.set('minHit', S.minHit); store.set('sort', S.sort); store.set('picks', S.picks); };

async function load() {
  const now = Date.now();
  const [status, lines] = await Promise.all([
    q('sync_status', { select: 'job,ran_at,ok,detail' }),
    q('current_lines', { select: '*', kickoff: `gte.${new Date(now - 5 * 3600e3).toISOString()}`, order: 'kickoff.asc' }),
  ]);
  const pids = [...new Set(lines.map(l => l.player_id).filter(Boolean))];
  const gids = [...new Set(lines.map(l => l.game_id).filter(Boolean))];
  const [players, logs, games, defense, injuries] = await Promise.all([
    qIn('players', 'player_id', pids, { select: 'player_id,name,position,team,headshot_url' }),
    qIn('player_games', 'player_id', pids, {
      select: 'player_id,game_id,season,week,season_type,team,opponent,is_home,pass_att,pass_yds,rush_yds,rec,rec_yds,target_share',
      order: 'season.desc,week.desc',
    }, 40),
    qIn('games', 'game_id', gids, { select: 'game_id,season,week,kickoff,home_team,away_team' }),
    q('defense_vs_position', { select: '*' }),
    qIn('injuries', 'player_id', pids, { select: 'player_id,season,week,report_status,injury,practice_status', order: 'season.desc,week.desc' }),
  ]);

  const byId = a => Object.fromEntries(a.map(x => [x.player_id ?? x.game_id, x]));
  const logsBy = {};
  logs.forEach(g => (logsBy[g.player_id] ||= []).push(g));
  Object.values(logsBy).forEach(a => a.sort((x, y) => y.season - x.season || y.week - x.week));
  const injBy = {};
  injuries.forEach(i => { if (!injBy[i.player_id]) injBy[i.player_id] = i; });
  const def = {};
  defense.forEach(d => { def[`${d.defense}|${d.position}`] = d; });

  S.data = {
    status: Object.fromEntries(status.map(s => [s.job, s])),
    lines, players: byId(players), games: byId(games), logsBy, injBy, def,
  };
  const books = new Set(lines.map(l => l.book));
  if (books.size && !books.has(S.book)) S.book = [...books][0];
}

// ---------- prop math ----------
function projection(values) {
  // Recency-weighted average of up to the last 16 games (most recent counts most).
  const v = values.slice(0, 16);
  if (!v.length) return null;
  let num = 0, den = 0;
  v.forEach((x, i) => { const w = Math.pow(0.85, i); num += w * x; den += w; });
  return num / den;
}

function analyze(line, n) {
  const d = S.data;
  const m = MARKETS[line.market];
  const p = d.players[line.player_id];
  const logs = (d.logsBy[line.player_id] || []).filter(g => m.val(g) != null);
  const values = logs.map(g => Number(m.val(g)));
  const L = Number(line.custom ?? line.line);
  const proj = projection(values);
  const edge = proj == null ? null : proj - L;
  const more = edge == null ? true : edge >= 0;
  const win = values.slice(0, n);
  const hits = win.filter(v => more ? v > L : v < L).length;
  const pct = win.length ? Math.round(hits / win.length * 100) : null;
  const recent = values.slice(0, 16);
  const mean = recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : 0;
  const sd = recent.length > 1 ? Math.sqrt(recent.reduce((x, y) => x + (y - mean) ** 2, 0) / (recent.length - 1)) : 0;
  // Rank by how many standard deviations the projection sits from the line, trusting small samples less.
  const score = edge == null ? -1 : Math.abs(edge) / Math.max(sd, 0.5) * Math.min(1, recent.length / 8);
  const g = d.games[line.game_id] || line.game;
  const team = p?.team;
  let opp = '', oppTeam = null;
  if (g && team) {
    if (team === g.home_team) { opp = `vs ${g.away_team}`; oppTeam = g.away_team; }
    else { opp = `@ ${g.home_team}`; oppTeam = g.home_team; }
  }
  return {
    key: `${line.event_id}|${line.book}|${line.market}|${line.player_name}`,
    line, m, p, logs, values, L, proj, edge, more, win, hits, pct, team, opp, oppTeam, game: g, score, small: values.length < 5,
    kickoff: line.kickoff ? new Date(line.kickoff) : null,
  };
}

// ---------- rendering ----------
function header() {
  const st = S.data?.status?.lines;
  const ran = st ? new Date(st.ran_at) : null;
  const fresh = ran && (Date.now() - ran) < 6 * 3600e3;
  const week = Object.values(S.data?.games || {})[0]?.week;
  return `
  <header class="top">
    <div class="brand">
      <svg viewBox="0 0 30 30" fill="none" aria-hidden="true"><rect x="1" y="1" width="28" height="28" rx="9" stroke="#4BF08F" stroke-width="2"/><path d="M8 20l5-6 4 3 5-8" stroke="#4BF08F" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div><b>PROPLENS</b><small>NFL${week ? ` · Week ${week}` : ''}</small></div>
    </div>
    <div class="asof">
      <span><i class="dot ${fresh ? 'fresh' : ''}"></i>${ran ? `Lines ${esc(timeFmt.format(ran))}` : 'No lines yet'}</span>
      <small>Next ${esc(timeFmt.format(nextPull()))}</small>
    </div>
  </header>`;
}

function nextPull(from = new Date()) {
  let best = null;
  for (const p of PULLS) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), p.h));
    let add = (p.dow - d.getUTCDay() + 7) % 7;
    if (add === 0 && d <= from) add = 7;
    d.setUTCDate(d.getUTCDate() + add);
    if (!best || d < best) best = d;
  }
  return best;
}

function sparkHtml(a) {
  const win = a.win.slice().reverse();
  if (!win.length) return '<div class="spark"></div>';
  const max = Math.max(...win, a.L) * 1.08;
  const w = S.n === 20 ? 5 : S.n === 10 ? 10 : 18;
  const bars = win.map(v => `<i style="width:${w}px;height:${Math.max(4, Math.round(v / max * 44))}px;background:${v > a.L ? C.more : C.less}"></i>`).join('');
  return `<div class="spark" style="gap:${S.n === 20 ? 2 : 4}px"><div class="ln" style="bottom:${Math.round(a.L / max * 44)}px"></div>${bars}</div>`;
}

function cardHtml(a) {
  const name = a.p?.name || a.line.player_name;
  const pick = S.picks[a.key]?.side;
  const pctColor = a.pct == null || a.small ? C.muted : a.pct >= 70 ? (a.more ? C.more : C.less) : a.pct >= 55 ? C.warn : C.muted;
  const side = a.more ? 'More' : 'Less';
  const href = a.line.player_id ? `#/p/${encodeURIComponent(a.line.player_id)}/${a.line.market}` : null;
  const who = `<b>${esc(name)}${href ? ' <i>›</i>' : ''}</b><small>${esc([a.p?.position, a.team && `${a.team} ${a.opp}`, a.kickoff && kickFmt.format(a.kickoff)].filter(Boolean).join(' · '))}</small>`;
  return `
  <article class="card">
    <div class="card-top">
      ${href ? `<a class="who" href="${href}">${who}</a>` : `<div class="who">${who}</div>`}
      <div class="edge" style="color:${a.more ? C.more : C.less}">${a.edge == null ? 'No history' : `${side} ${a.edge >= 0 ? '+' : ''}${a.edge.toFixed(1)}`}</div>
    </div>
    <div class="card-mid">
      <div class="linebox"><small>${esc(a.m.long)}</small><b>${fmt1(a.L)}</b><small>Proj ${fmt1(a.proj)}</small></div>
      <div class="trend">
        ${sparkHtml(a)}
        <div class="pct"><b style="color:${pctColor}">${a.pct == null ? '–' : a.pct + '%'}</b><small>${a.win.length ? `${side} ${a.hits}/${a.win.length}${a.small ? ' · small sample' : ''}` : 'no games yet'}</small></div>
      </div>
    </div>
    <div class="picks">
      <button class="less" data-pick="less" data-key="${esc(a.key)}" aria-pressed="${pick === 'less'}">▼ Less</button>
      <button class="more" data-pick="more" data-key="${esc(a.key)}" aria-pressed="${pick === 'more'}">▲ More</button>
    </div>
  </article>`;
}

// ---------- search ----------
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.'-]/g, '');
function teamWords(abbr) { return abbr ? `${abbr} ${TEAMS[abbr] || ''}` : ''; }
function matchesQuery(a, qn) {
  if (!qn) return true;
  const hay = norm([a.p?.name || a.line.player_name, teamWords(a.team), teamWords(a.oppTeam),
    a.game && `${a.game.away_team} @ ${a.game.home_team}`].join(' '));
  return qn.split(/\s+/).every(t => hay.includes(t));
}
function matchesFilter(a) {
  const f = S.filter;
  if (!f) return true;
  if (f.type === 'team') return a.team === f.value;
  return (a.game?.game_id || a.line.event_id) === f.value;
}
let searchTimer = null;
function searchRemote(text) {
  clearTimeout(searchTimer);
  const term = norm(text).replace(/[^a-z0-9 ]/g, '').trim();
  if (term.length < 2) { S.remote = { q: '', rows: [] }; return; }
  searchTimer = setTimeout(async () => {
    try {
      const rows = await q('players', { select: 'player_id,name,position,team,last_season', name: `ilike.*${term.replace(/ /g, '*')}*`, order: 'last_season.desc,name.asc' });
      S.remote = { q: term, rows: rows.slice(0, 8) };
      if (S.query && norm(S.query).includes(term)) rerenderSearch();
    } catch (e) { console.warn('search failed', e); }
  }, 250);
}
function suggestionsHtml() {
  const qn = norm(S.query).trim();
  if (!qn) return '';
  const onBoard = new Set(S.data.lines.map(l => l.player_id));
  const players = new Map();
  Object.values(S.data.players).forEach(p => { if (norm(p.name).includes(qn)) players.set(p.player_id, p); });
  S.remote.rows.forEach(p => { if (norm(p.name).includes(qn.split(' ')[0])) players.set(p.player_id, p); });
  const pl = [...players.values()].sort((x, y) => onBoard.has(y.player_id) - onBoard.has(x.player_id)).slice(0, 6);
  const teams = Object.entries(TEAMS).filter(([k, v]) => norm(k) === qn || norm(v).includes(qn)).slice(0, 4);
  const seen = new Set();
  const games = Object.values(S.data.games).filter(g => {
    const hay = norm(`${teamWords(g.away_team)} ${teamWords(g.home_team)} ${g.away_team} @ ${g.home_team}`);
    return qn.split(/\s+/).every(t => hay.includes(t)) && !seen.has(g.game_id) && seen.add(g.game_id);
  }).slice(0, 4);
  if (!pl.length && !teams.length && !games.length) return `<div class="sugg"><p class="sugg-none">No players, teams or games match "${esc(S.query)}".</p></div>`;
  const pRows = pl.map(p => `<a class="sugg-row" href="#/p/${encodeURIComponent(p.player_id)}"><span><b>${esc(p.name)}</b><small>${esc([p.position, p.team].filter(Boolean).join(' · '))}</small></span><em>${onBoard.has(p.player_id) ? 'On board' : 'No line today'}</em></a>`).join('');
  const tRows = teams.map(([k, v]) => `<button class="sugg-row" data-filter-team="${k}"><span><b>${esc(v)}</b><small>${k} · show their props</small></span><em>Team</em></button>`).join('');
  const gRows = games.map(g => `<button class="sugg-row" data-filter-game="${esc(g.game_id)}" data-label="${esc(`${g.away_team} @ ${g.home_team}`)}"><span><b>${esc(`${g.away_team} @ ${g.home_team}`)}</b><small>${esc(g.kickoff ? kickFmt.format(new Date(g.kickoff)) : '')}</small></span><em>Game</em></button>`).join('');
  return `<div class="sugg">${pl.length ? `<h3>Players</h3>${pRows}` : ''}${teams.length ? `<h3>Teams</h3>${tRows}` : ''}${games.length ? `<h3>Games</h3>${gRows}` : ''}</div>`;
}
function rerenderSearch() {
  const box = document.getElementById('search');
  const pos = box ? box.selectionStart : null;
  rerender();
  const again = document.getElementById('search');
  if (again && pos != null) { again.focus(); again.setSelectionRange(pos, pos); }
}

function boardHtml() {
  const d = S.data;
  const books = [...new Set(d.lines.map(l => l.book))];
  const bookBtns = Object.entries(BOOKS).map(([k, v]) =>
    `<button data-book="${k}" aria-pressed="${S.book === k}" ${books.includes(k) ? '' : 'disabled'}>${v}</button>`).join('');
  const statBtns = [['all', 'All'], ...Object.entries(MARKETS).map(([k, v]) => [k, v.label])].map(([k, v]) =>
    `<button data-stat="${k}" aria-pressed="${S.stat === k}">${v}</button>`).join('');
  const winBtns = [5, 10, 20].map(n => `<button data-n="${n}" aria-pressed="${S.n === n}">L${n}</button>`).join('');
  const sortBtns = [['edge', 'Edge'], ['game', 'Game'], ['team', 'Team']].map(([k, v]) =>
    `<button data-sort="${k}" aria-pressed="${S.sort === k}">${v}</button>`).join('');

  // While searching or filtering to a team/game, show every matching prop regardless of hit rate.
  const searching = !!(S.query.trim() || S.filter);
  let props = d.lines.filter(l => l.book === S.book && MARKETS[l.market] && (S.stat === 'all' || l.market === S.stat))
    .map(l => analyze(l, S.n))
    .filter(a => matchesFilter(a) && matchesQuery(a, searching ? norm(S.query).trim() : ''))
    .filter(a => searching || (a.pct == null ? S.minHit === 0 : a.pct >= S.minHit))
    .sort((x, y) => y.score - x.score);

  let list;
  if (!d.lines.length) {
    list = `<div class="empty"><strong>No lines on the board yet</strong>Lines are pulled Thursday, Sunday morning and Monday before kickoffs. Check back after the next pull.</div>`;
  } else if (!props.length) {
    list = searching
      ? `<div class="empty">No props on the board for this search${S.filter ? ` (${esc(S.filter.label)})` : ''}.</div>`
      : `<div class="empty">No props clear this hit rate. Lower the slider or widen the sample.</div>`;
  } else if (S.sort === 'edge') {
    list = props.map(cardHtml).join('');
  } else {
    const groups = new Map();
    props.forEach(a => {
      const k = S.sort === 'game' ? (a.game?.game_id || a.line.event_id) : (a.team || '—');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    });
    const keys = [...groups.keys()].sort((x, y) => S.sort === 'game'
      ? groups.get(x)[0].kickoff - groups.get(y)[0].kickoff || x.localeCompare(y)
      : x.localeCompare(y));
    list = keys.map(k => {
      const g = groups.get(k), a0 = g[0];
      const count = `${g.length} ${g.length === 1 ? 'prop' : 'props'}`;
      const title = S.sort === 'game'
        ? (a0.game ? `${a0.game.away_team} @ ${a0.game.home_team}` : 'Game')
        : k;
      const sub = S.sort === 'game' ? `${kickFmt.format(a0.kickoff)} · ${count}` : `${a0.opp} · ${kickFmt.format(a0.kickoff)} · ${count}`;
      return `<section style="display:flex;flex-direction:column;gap:10px"><div class="group-h"><h2>${esc(title)}</h2><span>${esc(sub)}</span></div>${g.map(cardHtml).join('')}</section>`;
    }).join('');
  }

  const searchNote = searching ? '<p class="search-note">Showing every hit rate while searching.</p>' : '';
  const chip = S.filter ? `<div class="filter-chip"><span>${esc(S.filter.label)}</span><button data-clear-filter aria-label="Clear ${esc(S.filter.label)} filter">✕</button></div>` : '';
  return `${header()}
  <div class="search">
    <label for="search" class="sr-only">Search players, teams or games</label>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
    <input id="search" type="search" placeholder="Search players, teams, games" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" value="${esc(S.query)}">
    ${S.query ? '<button class="search-x" data-clear-search aria-label="Clear search">✕</button>' : ''}
  </div>
  ${suggestionsHtml()}
  ${chip}
  <div class="sites">${bookBtns}</div>
  <div class="panel">
    <div class="row"><span class="label">Sample</span><div class="seg">${winBtns}</div></div>
    <div>
      <div class="row"><label class="label" for="minhit">Min hit rate</label><span class="slider-val">${S.minHit}%+</span></div>
      <input id="minhit" type="range" min="0" max="90" step="10" value="${S.minHit}">
    </div>
  </div>
  <div class="chips scroll-x">${statBtns}</div>
  <div class="listbar"><span>${props.length} ${props.length === 1 ? 'prop' : 'props'} · ${BOOKS[S.book] || ''}</span>
    <div class="sort" role="group" aria-label="Sort props"><span>SORT</span>${sortBtns}</div></div>
  ${searchNote}
  <div class="list">${list}</div>
  <p class="note">Hit rates describe past games, not future results. Projections are a simple recency-weighted average.</p>`;
}

function playerHtml(pid, market) {
  const d = S.data;
  const p = d.players[pid];
  if (!p) return `<div class="empty"><strong>Player not found</strong><a href="#/">Back to the board</a></div>`;
  const mine = d.lines.filter(l => l.player_id === pid && MARKETS[l.market]);
  const siteLine = mine.length > 0;
  let markets, line;
  if (siteLine) {
    const inBook = mine.filter(l => l.book === S.book);
    const pool = inBook.length ? inBook : mine;
    markets = [...new Set(pool.map(l => l.market))];
    if (!markets.includes(market)) market = markets[0];
    line = pool.find(l => l.market === market);
  } else {
    // No line today: start from a line near the player's recent average, which you can adjust.
    const logs = d.logsBy[pid] || [];
    const all = POS_MARKETS[p.position] || POS_MARKETS.WR;
    markets = all.filter(k => logs.some(g => Number(MARKETS[k].val(g)) > 0));
    if (!markets.length) markets = all;
    if (!markets.includes(market)) market = markets[0];
    const vals = logs.map(g => MARKETS[market].val(g)).filter(v => v != null).slice(0, 10).map(Number);
    const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
    const start = Math.floor(avg) + 0.5;
    const ng = d.nextGame?.[p.team];
    line = { market, line: start, first_line: start, player_id: pid, player_name: p.name, event_id: null, book: null,
      game: ng, game_id: ng?.game_id, kickoff: ng?.kickoff };
  }
  const ckey = `${pid}|${market}`;
  const baseLine = Number(line.line);
  const isCustom = S.custom[ckey] != null && S.custom[ckey] !== baseLine;
  const a = analyze({ ...line, custom: S.custom[ckey] }, S.n);
  const step = market === 'player_receptions' ? 1 : market === 'player_pass_yds' ? 10 : 5;
  const stepper = `<div class="stepper" role="group" aria-label="Adjust line">
      <button data-step="-${step}" data-base="${a.L}" data-ckey="${esc(ckey)}" aria-label="Lower line by ${step}">−</button>
      <button data-step="${step}" data-base="${a.L}" data-ckey="${esc(ckey)}" aria-label="Raise line by ${step}">+</button>
      ${isCustom ? `<button class="reset" data-step="reset" data-ckey="${esc(ckey)}">${siteLine ? 'Site line' : 'Reset'}</button>` : ''}
    </div>`;
  const n = S.n;
  const side = a.more ? 'More' : 'Less';
  const pick = S.picks[a.key]?.side;

  const shown = a.logs.slice(0, n).reverse();
  const vals = shown.map(g => Number(a.m.val(g)));
  const max = Math.max(...vals, a.L, 1) * 1.05;
  const plotH = n > 10 ? 150 : 130;
  const bars = shown.map((g, i) => `<div>${n <= 10 ? `<span>${Math.round(vals[i])}</span>` : ''}<i style="height:${Math.max(3, Math.round(vals[i] / max * plotH))}px;background:${vals[i] > a.L ? C.more : C.less}"></i></div>`).join('');
  const opps = shown.map(g => `<span>${n <= 10 ? esc(g.opponent) : ''}</span>`).join('');
  const lineBottom = 20 + Math.round(a.L / max * plotH);
  const avg = a.win.length ? a.win.reduce((s, v) => s + v, 0) / a.win.length : null;

  // Splits over the last 20 games for the suggested side.
  const last20 = a.logs.slice(0, 20);
  const hit = v => a.more ? v > a.L : v < a.L;
  const split = (label, games) => {
    const v = games.map(g => Number(a.m.val(g)));
    const h = v.filter(hit).length;
    const pct = v.length ? Math.round(h / v.length * 100) : 0;
    return `<div class="split"><span>${esc(label)}</span><div class="meter"><i style="width:${pct}%;background:${pct >= 60 ? C.more : pct >= 45 ? C.warn : C.less}"></i></div><b>${v.length ? `${h}/${v.length}` : '–'}</b></div>`;
  };
  const season = a.logs[0]?.season;
  const splits = [
    split('Home', last20.filter(g => g.is_home)),
    split('Away', last20.filter(g => !g.is_home)),
    split(`This season`, a.logs.filter(g => g.season === season && g.season_type === 'REG')),
    a.oppTeam ? split(`vs ${a.oppTeam} (all)`, a.logs.filter(g => g.opponent === a.oppTeam)) : '',
    split('Last 4', a.logs.slice(0, 4)),
  ].join('');

  // Context tiles
  const l3 = a.logs.slice(0, 3);
  const usage = p.position === 'QB'
    ? { label: 'Pass attempts (L3)', value: fmt1(l3.reduce((s, g) => s + (g.pass_att || 0), 0) / (l3.length || 1)) }
    : { label: 'Target share (L3)', value: l3.length ? Math.round(l3.reduce((s, g) => s + (Number(g.target_share) || 0), 0) / l3.length * 100) + '%' : '–' };
  const dv = a.oppTeam ? d.def[`${a.oppTeam}|${posGroup(p.position)}`] : null;
  const rank = dv ? dv[`${a.m.rank}_rank`] : null;
  const matchup = dv ? {
    label: `${a.oppTeam} vs ${posGroup(p.position)}s`,
    value: ordinal(rank),
    sub: `${rank >= 22 ? 'Soft' : rank <= 10 ? 'Tough' : 'Average'} · allows ${fmt1(dv[a.m.rank])}/gm (${dv.games} gms)`,
  } : { label: 'Matchup', value: '–', sub: 'Not enough games yet' };
  const first = Number(line.first_line), moved = Number(line.line) - first;
  const inj = d.injBy[pid];
  const injText = inj && (inj.report_status || (inj.practice_status && !/^Full/.test(inj.practice_status)))
    ? `${inj.report_status || 'Practice'}: ${inj.injury || ''} · ${inj.practice_status || ''} (week ${inj.week})`
    : 'No injury designation on the latest report';
  const injColor = inj?.report_status ? (/Out|Doubtful/.test(inj.report_status) ? C.less : C.warn) : C.more;

  const mkBtns = markets.map(k => `<button data-market="${k}" aria-pressed="${k === market}">${MARKETS[k].label}</button>`).join('');
  const winBtns = [5, 10, 20].map(x => `<button data-n="${x}" aria-pressed="${n === x}">L${x}</button>`).join('');
  const initials = (p.name || '').split(' ').map(s => s[0]).slice(0, 2).join('');
  const ran = line.fetched_at ? new Date(line.fetched_at) : null;
  const topNote = siteLine ? `${BOOKS[line.book] || line.book} · lines as of ${timeFmt.format(ran)}` : 'No line today · set your own below';

  return `
  <header class="p-top">
    <a class="iconbtn" href="#/" aria-label="Back to board"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></a>
    <span>${esc(topNote)}</span>
    <span style="width:44px"></span>
  </header>
  <div class="p-body">
    <div class="p-id">
      ${p.headshot_url ? `<img src="${esc(p.headshot_url)}" alt="" onerror="this.style.visibility='hidden'">` : `<div class="ph">${esc(initials)}</div>`}
      <div><h1>${esc(p.name)}</h1><small>${esc([p.position, a.team && `${a.team} ${a.opp}`.trim(), a.kickoff && kickFmt.format(a.kickoff)].filter(Boolean).join(' · '))}</small></div>
    </div>
    <div class="chips p-chips scroll-x">${mkBtns}</div>
    <section class="box">
      <div class="row" style="align-items:flex-start">
        <div class="bigline"><small class="label">${esc(a.m.long)}${isCustom || !siteLine ? ' · your line' : ''}</small><b>${fmt1(a.L)}</b></div>
        <div class="seg">${winBtns}</div>
      </div>
      ${stepper}
      <div class="tiles3">
        <div><small>${side} rate</small><b style="color:${a.more ? C.more : C.less}">${a.win.length ? `${a.hits}/${a.win.length}` : '–'}</b></div>
        <div><small>Average</small><b>${fmt1(avg)}</b></div>
        <div><small>Projection</small><b>${fmt1(a.proj)}</b></div>
      </div>
      <div class="chart">
        <div class="ln" style="bottom:${lineBottom}px"></div>
        <span class="ln-l" style="bottom:${lineBottom + 2}px">${fmt1(a.L)}</span>
        <div class="bars" style="gap:${n > 10 ? 3 : 6}px">${bars}</div>
        <div class="opps" style="gap:${n > 10 ? 3 : 6}px">${opps}</div>
      </div>
      <div class="legend"><span><i style="background:${C.more}"></i>Over line</span><span><i style="background:${C.less}"></i>Under line</span><em>Oldest → latest</em></div>
    </section>
    <section class="section"><h2>${side} rate · splits</h2><div class="splits">${splits}</div></section>
    <section class="tiles2">
      <div><small>${esc(usage.label)}</small><b>${esc(usage.value)}</b></div>
      <div><small>Games in sample</small><b>${a.logs.length}</b><small>last 2 seasons</small></div>
      <div><small>${esc(matchup.label)}</small><b>${esc(matchup.value)}</b><small>${esc(matchup.sub || '')}</small></div>
      ${siteLine
        ? `<div><small>Line move</small><b>${fmt1(first)} → ${fmt1(line.line)}</b><small style="color:${moved ? C.warn : C.muted}">${moved ? `Moved ${moved > 0 ? 'up' : 'down'} since first seen` : 'Unchanged since first seen'}</small></div>`
        : `<div><small>Site line</small><b>None today</b><small>Not posted yet, or no game</small></div>`}
    </section>
    <div class="status"><i class="dot" style="background:${injColor}"></i><span>${esc(injText)}</span></div>
    <p class="note" style="margin:0">Hit rates describe past games, not future results. Set limits and play responsibly.</p>
  </div>
  ${siteLine && !isCustom ? `<div class="cta">
    <button class="less" data-pick="less" data-key="${esc(a.key)}" aria-pressed="${pick === 'less'}">▼ Less ${fmt1(a.L)}</button>
    <button class="more" data-pick="more" data-key="${esc(a.key)}" aria-pressed="${pick === 'more'}">▲ More ${fmt1(a.L)}</button>
  </div>` : ''}`;
}

function slipHtml() {
  const items = Object.entries(S.picks);
  const rows = items.map(([key, p]) => `
    <div class="slip-item">
      <div><b>${esc(p.name)}</b><small>${esc(MARKETS[p.market]?.long || p.market)} · ${esc(BOOKS[p.book] || p.book)}</small></div>
      <span class="side" style="color:${p.side === 'more' ? C.more : C.less}">${p.side === 'more' ? '▲ More' : '▼ Less'} ${fmt1(p.line)}</span>
      <button class="textbtn" data-remove="${esc(key)}" aria-label="Remove ${esc(p.name)}">Remove</button>
    </div>`).join('');
  return `<div class="page-h"><h1>Slip</h1><p>Your shortlist. Build the actual entry on the site you play.</p></div>
  <div class="list">${rows || '<div class="empty">No picks yet. Tap More or Less on any prop.</div>'}
  ${items.length ? '<button class="textbtn" data-clear style="align-self:center">Clear all</button>' : ''}</div>`;
}

function aboutHtml() {
  const st = S.data?.status || {};
  const lines = st.lines, stats = st.stats;
  const credits = lines?.detail?.credits_remaining;
  return `<div class="page-h"><h1>About</h1><p>How the numbers are made.</p></div>
  <div class="prose">
    <h2>Data</h2>
    <p>Lines for PrizePicks, Underdog and DraftKings Pick6 come from The Odds API a few times a week. Game logs, schedules and injury reports come from nflverse and refresh daily.</p>
    <p>Stats last updated: ${stats ? esc(timeFmt.format(new Date(stats.ran_at))) : '–'}<br>
    Lines last pulled: ${lines ? esc(timeFmt.format(new Date(lines.ran_at))) : '–'}${credits != null ? ` · ${credits} API credits left this month` : ''}</p>
    <h2>Numbers</h2>
    <p><b>Hit rate</b> is how often the player cleared this line on the suggested side in the chosen sample (L5/L10/L20). <b>Projection</b> is a recency-weighted average of the last 16 games, and <b>edge</b> is projection minus line.</p>
    <p>These describe the past. They aren't predictions or advice. Set limits and play responsibly.</p>
  </div>`;
}

// ---------- routing & events ----------
// Load history for a player who isn't on today's board (opened from search).
const loadingPlayers = new Set();
async function ensurePlayer(pid) {
  const d = S.data;
  if (d.players[pid] && d.logsBy[pid]) return;
  const [pl, logs, inj] = await Promise.all([
    q('players', { select: 'player_id,name,position,team,headshot_url', player_id: `eq.${pid}` }),
    q('player_games', { select: 'player_id,game_id,season,week,season_type,team,opponent,is_home,pass_att,pass_yds,rush_yds,rec,rec_yds,target_share', player_id: `eq.${pid}`, order: 'season.desc,week.desc' }),
    q('injuries', { select: 'player_id,season,week,report_status,injury,practice_status', player_id: `eq.${pid}`, order: 'season.desc,week.desc' }),
  ]);
  if (!pl.length) return;
  d.players[pid] = pl[0];
  d.logsBy[pid] = logs;
  if (inj[0]) d.injBy[pid] = inj[0];
  const team = pl[0].team;
  d.nextGame ||= {};
  if (team && !(team in d.nextGame)) {
    const g = await q('games', { select: 'game_id,season,week,kickoff,home_team,away_team', or: `(home_team.eq.${team},away_team.eq.${team})`,
      kickoff: `gte.${new Date(Date.now() - 5 * 3600e3).toISOString()}`, order: 'kickoff.asc' });
    d.nextGame[team] = g[0] || null;
  }
}

function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean);
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on',
    (a.dataset.tab === 'board' && (!parts[0] || parts[0] === 'p')) || a.dataset.tab === parts[0]));
  const badge = document.getElementById('slip-badge');
  const count = Object.keys(S.picks).length;
  badge.hidden = !count; badge.textContent = count;
  if (!S.data) return;

  if (parts[0] === 'p') {
    const pid = decodeURIComponent(parts[1] || '');
    const known = S.data.players[pid];
    if (known === undefined || (known && !S.data.logsBy[pid])) {
      $view.innerHTML = '<div class="loading">Loading player…</div>';
      if (!loadingPlayers.has(pid)) {
        loadingPlayers.add(pid);
        ensurePlayer(pid).catch(e => console.warn(e)).finally(() => {
          loadingPlayers.delete(pid);
          if (!S.data.players[pid]) S.data.players[pid] = null;
          if (location.hash.includes(encodeURIComponent(pid))) route();
        });
      }
      return;
    }
    $view.innerHTML = playerHtml(pid, parts[2]);
  }
  else if (parts[0] === 'slip') $view.innerHTML = slipHtml();
  else if (parts[0] === 'about') $view.innerHTML = aboutHtml();
  else $view.innerHTML = boardHtml();
  $view.classList.toggle('has-cta', !!$view.querySelector('.cta'));
}

function rerender(keepScroll = true) {
  const y = window.scrollY;
  route();
  if (keepScroll) window.scrollTo(0, y);
}

$view.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.book) { S.book = b.dataset.book; }
  else if (b.dataset.n) { S.n = Number(b.dataset.n); }
  else if (b.dataset.stat) { S.stat = b.dataset.stat; }
  else if (b.dataset.sort) { S.sort = b.dataset.sort; }
  else if (b.dataset.filterTeam) { S.filter = { type: 'team', value: b.dataset.filterTeam, label: TEAMS[b.dataset.filterTeam] || b.dataset.filterTeam }; S.query = ''; }
  else if (b.dataset.filterGame) { S.filter = { type: 'game', value: b.dataset.filterGame, label: b.dataset.label }; S.query = ''; }
  else if ('clearFilter' in b.dataset) { S.filter = null; }
  else if ('clearSearch' in b.dataset) { S.query = ''; S.remote = { q: '', rows: [] }; save(); rerenderSearch(); return; }
  else if (b.dataset.step) {
    const k = b.dataset.ckey;
    if (b.dataset.step === 'reset') delete S.custom[k];
    else S.custom[k] = Math.max(0.5, Number(b.dataset.base) + Number(b.dataset.step));
  }
  else if (b.dataset.market) {
    const parts = location.hash.split('/');
    location.hash = `#/p/${parts[2]}/${b.dataset.market}`;
    return;
  } else if (b.dataset.pick) {
    const key = b.dataset.key, side = b.dataset.pick;
    if (S.picks[key]?.side === side) delete S.picks[key];
    else {
      const l = S.data.lines.find(x => `${x.event_id}|${x.book}|${x.market}|${x.player_name}` === key);
      S.picks[key] = { side, name: S.data.players[l.player_id]?.name || l.player_name, market: l.market, line: l.line, book: l.book, pid: l.player_id };
    }
  } else if (b.dataset.remove) { delete S.picks[b.dataset.remove]; }
  else if ('clear' in b.dataset) { S.picks = {}; }
  else return;
  save();
  rerender();
});
$view.addEventListener('input', e => {
  if (e.target.id === 'search') {
    S.query = e.target.value;
    searchRemote(S.query);
    rerenderSearch();
    return;
  }
  if (e.target.id === 'minhit') {
    S.minHit = Number(e.target.value);
    save();
    rerender();
    document.getElementById('minhit')?.focus();
  }
});
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

load().then(route).catch(err => {
  console.error(err);
  $view.innerHTML = `<div class="empty"><strong>Couldn't load the board</strong>${esc(err.message)}. Check your connection and refresh.</div>`;
});
