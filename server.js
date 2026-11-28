'use strict';
/* Fogo Nos Bacon — servidor multiplayer V1.2.1 (Correio, Veículos, Conjunto do Fundador) — base V1.1.1 (protocolo 2, compatível com o cliente V1.1)
   Matchmaking 1v1 (melhor de 7 rounds), salas privadas, reconexão, amigos, chat, convites, esquadrões,
   parede de gelo sincronizada, loadout por jogador e indicação (YouTube) com itens limitados. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
/* ===== logger (embutido) ===== */
const logger = (() => { const module = { exports: {} };
'use strict';
/* Logger de eventos do Fogo Nos Bacon.
   Escreve 1 linha JSON por evento no stdout -> o Render guarda e deixa pesquisar. */


// Sal secreto: defina LOG_SALT no Render (Environment). Sem ele, o hash ainda funciona.
const SALT = process.env.LOG_SALT || 'troque-esse-sal';

// Níveis: debug < info < warn < error. LOG_LEVEL=debug mostra tudo.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

// Qualquer campo com esses nomes NUNCA vai para o log (rede de proteção contra erro seu).
const FORBIDDEN = /pass|senha|secret|verify|cookie|jwt|authorization|api.?key|session|^token$/i;

// Transforma um ID (pid, código de sala) num código curto irreversível.
// Assim você consegue procurar "o mesmo jogador" sem expor o pid real (que funciona como chave).
function hash(v) {
  return crypto.createHash('sha256').update(SALT + String(v)).digest('hex').slice(0, 10);
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (FORBIDDEN.test(k)) continue;                       // descarta campo proibido
    out[k] = typeof v === 'string' ? v.slice(0, 100) : v;  // limita tamanho (evita lixo/spam)
  }
  return out;
}

function log(level, event, data) {
  if ((LEVELS[level] || 0) < MIN) return;
  const line = { ts: new Date().toISOString(), level, event, ...clean(data) };
  console.log(JSON.stringify(line));
}

module.exports = {
  hash,
  debug: (e, d) => log('debug', e, d),
  info: (e, d) => log('info', e, d),
  warn: (e, d) => log('warn', e, d),
  error: (e, d) => log('error', e, d),
};

return module.exports; })();
/* ===== G (embutido) ===== */
const G = (() => { const module = { exports: {} };
'use strict';
/* Fogo Nos Bacon — regras puras (sem rede) usadas pelo servidor e pelos testes. */

const normKey = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/* ---------- 1v1: 7 rounds (melhor de 7 — vence quem fizer 4 primeiro) ---------- */
const ROUNDS_TOTAL = 7;
const ROUNDS_TO_WIN = Math.floor(ROUNDS_TOTAL / 2) + 1; // 4

function createRounds(pids, total = ROUNDS_TOTAL) {
  const score = {}; for (const id of pids) score[id] = 0;
  return { total, toWin: Math.floor(total / 2) + 1, current: 1, phase: 'live', score, history: [], startedAt: Date.now(), roundStartedAt: Date.now(), winner: null };
}
/* Registra o vencedor do round atual. Retorna { matchOver, winner }. */
function applyRoundWin(rounds, winnerPid, reason = 'kill') {
  if (!rounds || rounds.phase !== 'live' || !(winnerPid in rounds.score)) return { matchOver: rounds ? rounds.phase === 'done' : false, winner: rounds ? rounds.winner : null, ignored: true };
  rounds.score[winnerPid]++;
  rounds.history.push({ round: rounds.current, winner: winnerPid, reason, durationMs: Date.now() - rounds.roundStartedAt });
  const matchOver = rounds.score[winnerPid] >= rounds.toWin || rounds.current >= rounds.total;
  if (matchOver) { rounds.phase = 'done'; rounds.winner = leader(rounds); }
  else rounds.phase = 'intermission';
  return { matchOver, winner: matchOver ? rounds.winner : null };
}
function nextRound(rounds) {
  if (!rounds || rounds.phase !== 'intermission') return false;
  rounds.current++; rounds.phase = 'live'; rounds.roundStartedAt = Date.now(); return true;
}
function forfeit(rounds, winnerPid) {
  if (!rounds) return;
  rounds.phase = 'done'; rounds.winner = winnerPid;
  rounds.history.push({ round: rounds.current, winner: winnerPid, reason: 'forfeit', durationMs: Date.now() - rounds.roundStartedAt });
}
function leader(rounds) { let best = null; for (const [id, s] of Object.entries(rounds.score)) if (best === null || s > rounds.score[best]) best = id; return best; }
const publicRounds = r => r ? { total: r.total, toWin: r.toWin, current: r.current, phase: r.phase, score: { ...r.score }, history: r.history.slice(), winner: r.winner } : null;

/* ---------- parede de gelo (arco de cilindro, igual ao cliente) ---------- */
const WALL = { HP: 150, DMG_PER_HIT: 34, HEIGHT: 3.2, MAX_PER_OWNER: 3, MAX_PER_ROOM: 30, TTL_MS: Number(process.env.WALL_TTL_MS) || 60000 };
const wrap = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
/* Distância 3D (ao longo do raio normalizado) até a parede, ou null se não acertar. */
function rayHitsWall(ox, oy, oz, dx, dy, dz, w, maxDist) {
  const hl = Math.hypot(dx, dz); if (hl < 1e-6) return null;
  const ux = dx / hl, uz = dz / hl, fx = ox - w.x, fz = oz - w.z;
  const b = fx * ux + fz * uz, c = fx * fx + fz * fz - w.rad * w.rad, disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  for (const t2 of [-b - sq, -b + sq]) {
    if (t2 < 0) continue;
    const px = ox + ux * t2, pz = oz + uz * t2;
    const ang = wrap(Math.atan2(px - w.x, pz - w.z) - w.rot - Math.PI);
    if (Math.abs(ang) > w.arc / 2) continue;
    const t3 = t2 / hl, y = oy + dy * t3;
    if (y < 0 || y > WALL.HEIGHT) continue;
    if (t3 <= maxDist) return t3;
  }
  return null;
}
function validWallInput(d) {
  return !!d && [d.x, d.z, d.rot, d.rad, d.arc].every(Number.isFinite) && d.rad >= 1 && d.rad <= 8 && d.arc >= 0.3 && d.arc <= 3.2 && Math.abs(d.x) < 400 && Math.abs(d.z) < 400;
}

/* ---------- indicação (YouTube) e itens limitados ---------- */
const REFERRALS = {
  bacon: { channel: 'Bacon Vascaino', url: 'https://youtube.com/@baconvascaino121', handle: '@baconvascaino121', gold: 3121,
    items: ['wpk_ref_vascaino', 'ice_ref_vasco'], packKey: 'refvasco', wallKey: 'refvasco', title: 'Veio Por Bacon Vascaino' },
  sunaura: { channel: 'Sunaura69', url: 'https://youtube.com/@sunaura69clips', handle: '@sunaura69clips', gold: 3696,
    items: ['wpk_ref_sunaura', 'ice_ref_sunaura'], packKey: 'refsunaura', wallKey: 'refsunaura', title: 'Veio Por Sunaura69' }
};
/* Aceita @, nome/nick ou link do canal. Retorna 'bacon' | 'sunaura' | null. */
function normalizeChannel(input) {
  let s = normKey(input);
  s = s.replace(/^https?:\/\//, '').replace(/^(www\.|m\.)/, '').replace(/^youtube\.com\//, '').replace(/^youtu\.be\//, '');
  s = s.split(/[?#]/)[0].replace(/[^a-z0-9]/g, '');
  if (!s) return null;
  if (s.includes('baconvascaino')) return 'bacon';
  if (s.includes('sunaura69')) return 'sunaura';
  return null;
}
const LIMITED_ITEM_IDS = new Set(Object.values(REFERRALS).flatMap(r => r.items));
const LIMITED_TITLES = new Set(Object.values(REFERRALS).map(r => r.title));
const LIMITED_PACKS = new Map(Object.entries(REFERRALS).map(([k, r]) => [r.packKey, k]));
const LIMITED_WALLS = new Map(Object.entries(REFERRALS).map(([k, r]) => [r.wallKey, k]));
const isLimitedItem = id => LIMITED_ITEM_IDS.has(String(id || ''));

const cut = (v, n = 24) => (typeof v === 'string' && v ? v.replace(/[<>\u0000-\u001f]/g, '').slice(0, n) : null);
/* ---------- exclusivos por conta (V1.2.1) ---------- */
const FOUNDER_KEYS = ['vascainobacon', 'vascainobaconpc'];
const RAFAEL_KEYS = ['rafael', 'rafaelmr'];
const SUNAURA_KEYS = ['sunaura69', 'sunaura'];
const isFounderKey = k => FOUNDER_KEYS.includes(normKey(k));
/* chave do item -> quem pode usar. Fundadores podem usar/testar TUDO (aba admin). */
const EXCLUSIVE = {
  pack: { fundador_malta: FOUNDER_KEYS, rafael_malta: RAFAEL_KEYS, sunaura_neon: SUNAURA_KEYS },
  wall: { fundador_vasco: FOUNDER_KEYS, rafael_gold: RAFAEL_KEYS, sunaura_cover: SUNAURA_KEYS },
  skin: { fundador_tatico: FOUNDER_KEYS, rafael_tatico: RAFAEL_KEYS },
  title: { 'O Vascaíno Supremo': FOUNDER_KEYS, 'O Escolhido de Novembro': RAFAEL_KEYS }
};
function canUseExclusive(kind, key, nameKey) {
  const list = EXCLUSIVE[kind] && EXCLUSIVE[kind][key];
  if (!list) return true;
  const k = normKey(nameKey);
  return isFounderKey(k) || list.includes(k);
}
/* ---------- veículos ---------- */
const VEHICLES = {
  uno:   { name: 'Fiat Uno', hp: 320, radius: 1.6, maxSpeed: 26 },
  moto:  { name: 'Moto de Grau', hp: 180, radius: 1.1, maxSpeed: 31 },
  truck: { name: 'Caminhão Pesado', hp: 760, radius: 2.4, maxSpeed: 17 }
};
const VEH_EXPLODE = { RADIUS: 6.5, DAMAGE: 85 };
/* Distância ao longo do raio até a esfera do veículo, ou null. */
function rayHitsSphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxDist) {
  const fx = cx - ox, fy = cy - oy, fz = cz - oz, t = fx * dx + fy * dy + fz * dz;
  if (t < 0 || t > maxDist) return null;
  return Math.hypot(fx - dx * t, fy - dy * t, fz - dz * t) < r ? t : null;
}

/* Remove do loadout os limitados que a conta não ganhou pela indicação e exclusivos de outras contas. */
function sanitizeLoadout(d, referralChannel, nameKey) {
  d = d || {};
  const out = { skin: cut(d.skin), pack: cut(d.pack), wall: cut(d.wall), title: cut(d.title, 40), vehicle: VEHICLES[d.vehicle] ? d.vehicle : null, vskin: cut(d.vskin) };
  for (const kind of ['pack', 'wall', 'skin', 'title']) if (out[kind] && !canUseExclusive(kind, out[kind], nameKey)) out[kind] = null;
  const founder = isFounderKey(nameKey);
  if (!founder && out.pack && LIMITED_PACKS.has(out.pack) && LIMITED_PACKS.get(out.pack) !== referralChannel) out.pack = null;
  if (!founder && out.wall && LIMITED_WALLS.has(out.wall) && LIMITED_WALLS.get(out.wall) !== referralChannel) out.wall = null;
  if (!founder && out.title && LIMITED_TITLES.has(out.title) && (!referralChannel || REFERRALS[referralChannel].title !== out.title)) out.title = null;
  return out;
}

module.exports = { normKey, ROUNDS_TOTAL, ROUNDS_TO_WIN, createRounds, applyRoundWin, nextRound, forfeit, publicRounds,
  WALL, rayHitsWall, validWallInput, REFERRALS, normalizeChannel, isLimitedItem, LIMITED_ITEM_IDS, LIMITED_TITLES, sanitizeLoadout,
  FOUNDER_KEYS, RAFAEL_KEYS, isFounderKey, canUseExclusive, EXCLUSIVE, VEHICLES, VEH_EXPLODE, rayHitsSphere };

return module.exports; })();

const VERSION = '1.2.1';
const PROTOCOL = 2;
const PORT = process.env.PORT || 3000;
const GRACE_MS = 15000;           // tempo para reconectar durante a partida
const INVITE_MS = 60000;
const DATA_FILE = process.env.FNB_DATA_FILE || path.join(__dirname, 'data', 'social.json');
const VERIFIED_NICKS = (process.env.VERIFIED_NICKS || 'VascainoBacon,VascainoBaconPC,RafaelMR').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const VERIFY_CODE = process.env.VERIFY_CODE || '';   // se vazio, ninguém é verificado online
// Contas que podem dar Bacon Coins / Tokens (precisam estar verificadas: VERIFY_CODE definido no Render e digitado no jogo)
const ADMIN_NICKS = (process.env.ADMIN_NICKS || 'vascainobacon,vascainobaconpc').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_GRANT = 10000000;

const WEAPONS = {
  pistol: { damage: 20, range: 120, cooldown: 280 }, rifle: { damage: 20, range: 120, cooldown: 120 },
  shotgun: { damage: 10, range: 38, cooldown: 850 }, ak47: { damage: 24, range: 90, cooldown: 130 },
  m4a1: { damage: 20, range: 100, cooldown: 105 }, mp5: { damage: 13, range: 50, cooldown: 90 },
  ump45: { damage: 17, range: 55, cooldown: 110 }, deagle: { damage: 52, range: 70, cooldown: 420 },
  awm: { damage: 105, range: 200, cooldown: 1400 }, m870: { damage: 12, range: 30, cooldown: 900 }
};
const MODES = { duel: { cap: 2, team: 1 }, duo: { cap: 4, team: 2 }, squad: { cap: 8, team: 4 } };

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url === '/stats/duels') { res.writeHead(200); return res.end(JSON.stringify({ duels: matchLog.slice(-20).map(m => ({ at: m.at, total: m.total, rounds: m.history.length, players: m.players.map(x => ({ name: x.name, score: x.score })) })) })); }
  if (url === '/health') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, version: VERSION, protocol: PROTOCOL })); }
  if (url === '/') {
    res.writeHead(200);
    return res.end(JSON.stringify({ message: 'Fogo Nos Bacon - Servidor Online!', game: 'Fogo Nos Bacon', version: VERSION, protocol: PROTOCOL,
      online: io.sockets.sockets.size, queue: queues.duel.length + queues.duo.length + queues.squad.length, rooms: rooms.size }));
  }
  res.writeHead(404); res.end(JSON.stringify({ error: 'not_found' }));
});
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 20000, pingTimeout: 25000
});

/* ---------- estado ---------- */
const profiles = new Map();   // pid -> perfil persistente (amigos, pedidos)
const rooms = new Map();      // code -> sala
const queues = { duel: [], duo: [], squad: [] };   // itens: { pids:[...] }
const squads = new Map();     // id -> { id, leader, members:Set }
const invites = new Map();    // id -> convite
const globalChat = [];
const privateChat = new Map();// "a|b" -> [msgs]
const mailboxes = new Map();  // nick normalizado -> [carta]  (V1.2.1)
const mailClaims = new Set(); // 'conta|campanha' e 'pid|campanha' -> resgate único por conta E por aparelho
const giftLog = new Map();    // pid -> { day, gold } limite diário de presentes em moedas
const grants = new Map();     // nick normalizado -> [{ id, kind:'tokens'|'gold', amount, from, ts }] (entregues até o jogador confirmar)
const referrals = new Map();  // conta normalizada -> { account, pid, channel, input, grantId, rewards, ts }
const refByPid = new Map();   // pid -> conta (1 resgate por aparelho)
const matchLog = [];          // últimas partidas 1v1 com placar de cada round

const uid = n => crypto.randomBytes(n).toString('hex').toUpperCase();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() { let c = ''; const b = crypto.randomBytes(6); for (let i = 0; i < 6; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length]; return c; }
const cleanName = v => String(v || 'Jogador').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18) || 'Jogador';
const cleanText = v => String(v || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 200);
const normKey = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const validPid = v => typeof v === 'string' && /^P-[A-F0-9]{8,16}$/.test(v);
const now = () => Date.now();

/* ---------- persistência (melhor esforço; disco do Render grátis é efêmero) ---------- */
let saveTimer = null;
function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const p of raw.profiles || []) profiles.set(p.pid, { pid: p.pid, name: p.name, friends: new Set(p.friends), incoming: new Set(p.incoming), outgoing: new Set(p.outgoing), loadout: p.loadout || {}, stats: p.stats || { w: 0, l: 0 }, sid: null, status: 'offline', verified: false, room: null, squad: null, lastChat: 0 });
    for (const rec of raw.referrals || []) { referrals.set(G.normKey(rec.account), rec); refByPid.set(rec.pid, G.normKey(rec.account)); }
    for (const m of raw.matches || []) matchLog.push(m);
    for (const [k, list] of Object.entries(raw.grants || {})) if (Array.isArray(list) && list.length) grants.set(k, list);
    for (const [k, list] of Object.entries(raw.mail || {})) if (Array.isArray(list)) mailboxes.set(k, list);
    for (const c of raw.mailClaims || []) mailClaims.add(c);
  } catch (_) { /* primeira execução */ }
}
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const out = { profiles: [...profiles.values()].map(p => ({ pid: p.pid, name: p.name, friends: [...p.friends], incoming: [...p.incoming], outgoing: [...p.outgoing], loadout: p.loadout || {}, stats: p.stats || { w: 0, l: 0 } })) };
      out.referrals = [...referrals.values()];
      out.matches = matchLog.slice(-500);
      out.grants = Object.fromEntries(grants);
      out.mail = Object.fromEntries(mailboxes);
      out.mailClaims = [...mailClaims];
      fs.writeFileSync(DATA_FILE, JSON.stringify(out));
    } catch (e) { logger.error('save_failed', { message: e.message }); }
  }, 1500);
  if (saveTimer.unref) saveTimer.unref();
}
loadData();

/* ---------- helpers ---------- */
const sockOf = p => (p && p.sid ? io.sockets.sockets.get(p.sid) : null);
const pub = p => ({ pid: p.pid, name: p.name, verified: !!p.verified, online: !!p.sid, status: p.sid ? p.status : 'offline' });
function emitTo(pid, ev, data) { const s = sockOf(profiles.get(pid)); if (s) s.emit(ev, data); }
function findByNameOrId(t) {
  const q = String(t || '').trim(); if (!q) return null;
  if (profiles.has(q.toUpperCase())) return profiles.get(q.toUpperCase());
  const lower = q.toLowerCase(); let hit = null;
  for (const p of profiles.values()) if (p.name.toLowerCase() === lower) { if (!hit || (p.sid && !hit.sid)) hit = p; }
  return hit;
}
function socialState(p) {
  const sq = p.squad ? squads.get(p.squad) : null;
  return {
    me: pub(p),
    friends: [...p.friends].map(id => profiles.get(id)).filter(Boolean).map(pub),
    incoming: [...p.incoming].map(id => profiles.get(id)).filter(Boolean).map(pub),
    outgoing: [...p.outgoing].map(id => profiles.get(id)).filter(Boolean).map(pub),
    squad: sq ? { id: sq.id, leader: sq.leader, members: [...sq.members].map(id => profiles.get(id)).filter(Boolean).map(pub) } : null,
    invites: [...invites.values()].filter(i => i.to === p.pid && i.exp > now()).map(i => ({ id: i.id, kind: i.kind, from: pub(profiles.get(i.from)), code: i.code || null })),
    room: p.room && rooms.get(p.room) ? roomInfo(rooms.get(p.room)) : null
  };
}
function pushSocial(pid) { const p = profiles.get(pid); const s = sockOf(p); if (s) s.emit('social:state', socialState(p)); }
function pushMany(pids) { for (const id of new Set(pids)) pushSocial(id); }
function pushFriendsOf(p) { pushMany([...p.friends]); }
const reply = (cb, obj) => { if (typeof cb === 'function') cb(obj); };
const fail = (socket, cb, event, message) => { socket.emit(event, { message }); reply(cb, { ok: false, message }); };

/* rate limit simples por socket */
function limited(socket, key, ms) {
  const t = now(), k = '_rl_' + key;
  if (socket.data[k] && t - socket.data[k] < ms) return true;
  socket.data[k] = t; return false;
}

/* ---------- entregas do admin (Bacon Coins / Tokens) ---------- */
const isAdmin = p => !!p && p.verified && ADMIN_NICKS.includes(normKey(p.name));
function onlineSocketsOfKey(key) {
  const out = [];
  for (const pr of profiles.values()) if (pr.sid && normKey(pr.name) === key) { const s = sockOf(pr); if (s) out.push(s); }
  return out;
}
function flushGrants(p) {
  const list = grants.get(normKey(p.name)); const s = sockOf(p);
  if (list && s) for (const g of list) s.emit('wallet:grant', g);
}

/* ---------- salas ---------- */
function roomInfo(r) {
  return { code: r.code, kind: r.kind, cap: r.cap, host: r.host, started: r.started,
    players: [...r.players.values()].map(pl => ({ pid: pl.pid, name: pl.name, verified: pl.verified, team: pl.team, online: !pl.offline })) };
}
function broadcastRoom(r) { io.to(r.code).emit('room:update', roomInfo(r)); }
const refChannelOf = p => { const rec = p ? referrals.get(G.normKey(p.name)) : null; return rec ? rec.channel : null; };
function newPlayer(p, extra = {}) {
  const lo = p.loadout || {};
  return Object.assign({ pid: p.pid, id: p.pid, name: p.name, verified: !!p.verified, skin: lo.skin || null, pack: lo.pack || null, wall: lo.wall || null, title: lo.title || null, ch: 'sentinel', team: 0,
    x: 0, z: 0, yaw: 0, pit: 0, hp: 100, armor: 0, kills: 0, alive: true, lastShot: 0, offline: false, dropTimer: null }, extra);
}
function createRoom(kind, host) {
  let code = makeCode(); while (rooms.has(code)) code = makeCode();
  const m = MODES[kind] || MODES.duel;
  const r = { code, kind, cap: m.cap, teamSize: m.team, host: host ? host.pid : null, players: new Map(), started: false, createdAt: now(), private: !!host };
  rooms.set(code, r); return r;
}
function addToRoom(r, p, socket, data = {}) {
  const pl = newPlayer(p, { skin: typeof data.skin === 'string' ? data.skin.slice(0, 24) : ((p.loadout && p.loadout.skin) || null), ch: typeof data.ch === 'string' ? data.ch.slice(0, 24) : 'sentinel' });
  r.players.set(p.pid, pl);
  p.room = r.code; socket.join(r.code); socket.data.room = r.code;
  return pl;
}
function assignTeams(r) {
  const list = [...r.players.values()]; let t = 0, n = 0;
  if (r.teamSize === 1) list.forEach((pl, i) => { pl.team = i + 1; });
  else for (const pl of list) { pl.team = t + 1; n++; if (n >= r.teamSize) { t++; n = 0; } }
}
function startRoom(r) {
  if (r.started || r.players.size < 2) return false;
  r.started = true; assignTeams(r);
  r.walls = new Map(); r.vehicles = new Map();
  r.rounds = r.kind === 'duel' ? G.createRounds([...r.players.keys()]) : null;
  logger.info('match_started', { room: logger.hash(r.code), mode: r.kind, players: r.players.size });
  const list = [...r.players.values()];
  placeSpawns(r); list.forEach(pl => { pl.kills = 0; });
  io.to(r.code).emit('match:ready', {
    room: r.code, kind: r.kind, you: null, rounds: G.publicRounds(r.rounds), walls: [],
    players: list.map(pl => ({ id: pl.pid, pid: pl.pid, name: pl.name, verified: pl.verified, skin: pl.skin, pack: pl.pack, wall: pl.wall, title: pl.title, ch: pl.ch, team: pl.team, spawn: { x: pl.x, z: pl.z, yaw: pl.yaw } }))
  });
  for (const pl of list) { const p = profiles.get(pl.pid); if (p) p.status = 'em partida'; }
  pushMany(list.map(pl => pl.pid));
  sendSnapshot(r);
  return true;
}
function placeSpawns(r) {
  const list = [...r.players.values()], radius = 20 + list.length * 3, flip = r.rounds && r.rounds.current % 2 === 0 ? Math.PI : 0;
  list.forEach((pl, i) => {
    const a = (i / list.length) * Math.PI * 2 + flip;
    pl.x = Math.cos(a) * radius; pl.z = Math.sin(a) * radius; pl.yaw = Math.atan2(pl.x, pl.z) + Math.PI;
    pl.hp = 100; pl.armor = 0; pl.alive = true;
  });
}
function snapshot(r) { return [...r.players.values()].map(p => ({ id: p.pid, name: p.name, verified: p.verified, skin: p.skin, pack: p.pack, wall: p.wall, title: p.title, ch: p.ch, team: p.team, x: p.x, z: p.z, yaw: p.yaw, pit: p.pit, hp: p.hp, alive: p.alive && !p.offline })); }

/* ---------- parede de gelo (autoritativa no servidor) ---------- */
const wallPub = w => ({ id: w.id, owner: w.owner, x: w.x, z: w.z, rot: w.rot, rad: w.rad, arc: w.arc, skin: w.skin, hp: w.hp, exp: w.exp });
function destroyWall(r, id, reason) {
  const w = r.walls && r.walls.get(id); if (!w) return;
  r.walls.delete(id);
  io.to(r.code).emit('wall:destroy', { id, reason });
  logger.debug('wall_destroyed', { room: logger.hash(r.code), reason });
}
function clearWalls(r) { if (!r.walls) return; r.walls.clear(); io.to(r.code).emit('wall:clear', {}); }
setInterval(() => { const t = now(); for (const r of rooms.values()) if (r.walls) for (const w of [...r.walls.values()]) if (w.exp < t) destroyWall(r, w.id, 'expirou'); }, 1000).unref();

/* ---------- 1v1: rounds ---------- */
function recordMatch(r) {
  if (!r.rounds || r.recorded) return; r.recorded = true;
  const players = [...r.players.values()].map(pl => ({ pid: pl.pid, name: pl.name, score: r.rounds.score[pl.pid] || 0 }));
  matchLog.push({ room: r.code, at: now(), winner: r.rounds.winner, total: r.rounds.total, players, history: r.rounds.history });
  if (matchLog.length > 500) matchLog.shift();
  for (const pl of players) { const p = profiles.get(pl.pid); if (p) { p.stats = p.stats || { w: 0, l: 0 }; if (pl.pid === r.rounds.winner) p.stats.w++; else p.stats.l++; } }
  saveData();
  logger.info('duel_recorded', { room: logger.hash(r.code), rounds: r.rounds.history.length, winner: r.rounds.winner ? logger.hash(r.rounds.winner) : null });
}
function finishDuel(r, reason) {
  r.ended = true; recordMatch(r);
  io.to(r.code).emit('round:state', G.publicRounds(r.rounds));
  const w = r.players.get(r.rounds.winner);
  io.to(r.code).emit('match:end', { winner: r.rounds.winner, winnerTeam: w ? w.team : 0, kills: w ? w.kills : 0, rounds: G.publicRounds(r.rounds), reason });
  setTimeout(() => destroyRoom(r.code), 3000).unref?.();
}
function roundWon(r, winnerPid, reason) {
  const res = G.applyRoundWin(r.rounds, winnerPid, reason);
  if (res.ignored) return;
  const last = r.rounds.history[r.rounds.history.length - 1];
  io.to(r.code).emit('round:end', { round: last.round, winner: winnerPid, reason, rounds: G.publicRounds(r.rounds) });
  logger.info('round_end', { room: logger.hash(r.code), round: last.round, winner: logger.hash(winnerPid) });
  saveData();
  if (res.matchOver) return finishDuel(r, 'rounds');
  r.roundTimer = setTimeout(() => {
    if (!rooms.has(r.code) || r.ended || !G.nextRound(r.rounds)) return;
    clearWalls(r); placeSpawns(r);
    io.to(r.code).emit('round:start', { round: r.rounds.current, rounds: G.publicRounds(r.rounds),
      spawns: Object.fromEntries([...r.players.values()].map(pl => [pl.pid, { x: pl.x, z: pl.z, yaw: pl.yaw }])) });
    sendSnapshot(r);
  }, 4000);
  r.roundTimer.unref?.();
}
function onDeath(r, victimPid, killerPid) {
  if (r.rounds) {
    if (r.rounds.phase !== 'live') return;
    const other = killerPid && killerPid !== victimPid ? killerPid : [...r.players.keys()].find(id => id !== victimPid);
    return roundWon(r, other, killerPid ? 'kill' : 'morte');
  }
  checkEnd(r, killerPid);
}
function sendSnapshot(r) { io.to(r.code).emit('players:snapshot', snapshot(r)); }
function checkEnd(r, killerPid) {
  if (!r.started || r.ended) return;
  const alive = [...r.players.values()].filter(p => p.alive && !p.offline);
  const teams = new Set(alive.map(p => p.team));
  if (teams.size <= 1) {
    r.ended = true;
    logger.info('match_ended', { room: logger.hash(r.code), mode: r.kind, winner_team: alive.length ? alive[0].team : 0, duration_s: Math.round((now() - r.createdAt) / 1000) });
    const winnerTeam = alive.length ? alive[0].team : 0;
    io.to(r.code).emit('match:end', { winner: alive.length ? alive[0].pid : killerPid || null, winnerTeam, kills: killerPid && r.players.get(killerPid) ? r.players.get(killerPid).kills : 0 });
    setTimeout(() => destroyRoom(r.code), 3000).unref?.();
  }
}
function destroyRoom(code) {
  const r = rooms.get(code); if (!r) return;
  clearTimeout(r.roundTimer);
  for (const pl of r.players.values()) {
    clearTimeout(pl.dropTimer);
    const p = profiles.get(pl.pid); if (p) { p.room = null; p.status = 'menu'; const s = sockOf(p); if (s) { s.leave(code); s.data.room = null; } }
  }
  rooms.delete(code);
  pushMany([...r.players.keys()]);
}
function leaveRoom(p, reason) {
  const r = p.room ? rooms.get(p.room) : null; if (!r) { p.room = null; return; }
  const pl = r.players.get(p.pid); clearTimeout(pl && pl.dropTimer);
  const s = sockOf(p); if (s) { s.leave(r.code); s.data.room = null; }
  if (r.started && !r.ended && r.rounds && r.players.size === 2) {
    const other = [...r.players.keys()].find(id => id !== p.pid);
    clearTimeout(r.roundTimer); G.forfeit(r.rounds, other); r.ended = true; recordMatch(r);
    io.to(r.code).emit('round:state', G.publicRounds(r.rounds));
  }
  r.players.delete(p.pid); p.room = null; p.status = 'menu';
  if (r.players.size === 0) { clearTimeout(r.roundTimer); rooms.delete(r.code); }
  else if (r.started) {
    io.to(r.code).emit('opponent:left', { pid: p.pid, name: p.name, reason: reason || 'saiu' });
    if (r.players.size < 2 || r.teamSize === 1) { io.to(r.code).emit('match:closed', { message: 'O outro jogador saiu da partida.' }); destroyRoom(r.code); }
    else checkEnd(r, null);
  } else {
    if (r.host === p.pid) r.host = [...r.players.keys()][0];
    broadcastRoom(r);
  }
  pushSocial(p.pid);
}

/* ---------- fila ---------- */
function dequeue(pid) {
  for (const k of Object.keys(queues)) queues[k] = queues[k].filter(e => !e.pids.includes(pid));
}
function tryMatch(kind) {
  const q = queues[kind], m = MODES[kind];
  q.splice(0, q.length, ...q.filter(e => e.pids.every(id => { const p = profiles.get(id); return p && p.sid && !p.room; })));
  if (kind === 'duel') {
    while (q.length >= 2) {
      const a = q.shift(), b = q.shift();
      const r = createRoom('duel', null);
      for (const e of [a, b]) for (const id of e.pids) { const p = profiles.get(id); addToRoom(r, p, sockOf(p), e.data[id]); }
      startRoom(r);
    }
    return;
  }
  // duo/esquadrão: junta grupos até encher a sala; inicia com no mínimo 2 jogadores após 20 s de espera
  let total = 0; for (const e of q) total += e.pids.length;
  const oldest = q[0] ? now() - q[0].at : 0;
  if (total >= m.cap || (total >= 2 && oldest > 20000)) {
    const r = createRoom(kind, null); let n = 0;
    while (q.length && n + q[0].pids.length <= m.cap) { const e = q.shift(); for (const id of e.pids) { const p = profiles.get(id); addToRoom(r, p, sockOf(p), e.data[id]); n++; } }
    startRoom(r);
  }
}
setInterval(() => { for (const k of ['duo', 'squad']) tryMatch(k); }, 2000).unref();

/* ---------- squads / convites ---------- */
function leaveSquad(p) {
  const sq = p.squad ? squads.get(p.squad) : null; p.squad = null; if (!sq) return;
  sq.members.delete(p.pid);
  if (!sq.members.size) squads.delete(sq.id);
  else { if (sq.leader === p.pid) sq.leader = [...sq.members][0]; pushMany([...sq.members]); }
  pushSocial(p.pid);
}
function expireInvites() { const t = now(); for (const [id, i] of invites) if (i.exp < t) { invites.delete(id); pushSocial(i.to); } }
setInterval(expireInvites, 10000).unref();

/* ---------- correio (V1.2.1) ---------- */
const MAIL_MAX = 60, GIFT_GOLD_DAY = 50000;
const SHOP_GIFTABLE = /^(skin_|wpk_|ice_|chute_|veh_|vpaint_)[a-z0-9_]{1,40}$/;
const EXCLUSIVE_ITEM_IDS = new Set(['skin_fundador_tatico', 'wpk_fundador', 'ice_fundador', 'chute_uno_fundador', 'skin_rafael_tatico', 'wpk_rafael', 'ice_rafael', 'chute_tarot_rafael', 'wpk_sunaura_neon', 'chute_voo_sunaura']);
/* Cartas de campanha: criadas sob demanda para quem tem direito. */
const CAMPAIGNS = [
  { id: 'C-UPDATE-130', who: () => true, from: 'Equipe Fogo Nos Bacon', subject: '🔥 Atualização V1.2.1 chegou!',
    body: 'Correio, Garagem com Fiat Uno, Moto de Grau e Caminhão, e muito mais. Toma um presente pra estrear!',
    rewards: { gold: 1500, items: ['veh_uno'] } },
  { id: 'C-BDAY-RAFAEL', who: k => G.RAFAEL_KEYS.includes(k), from: 'Bacon Vascaíno', subject: '🎂 Feliz aniversário, Rafael!',
    body: 'O Escolhido de Novembro merece o melhor. Seu Conjunto de Aniversário completo está aqui dentro. Parabéns, irmão!',
    rewards: { gold: 11000, title: 'O Escolhido de Novembro', items: ['skin_rafael_tatico', 'wpk_rafael', 'ice_rafael', 'chute_tarot_rafael', 'veh_moto'] } },
  { id: 'C-FOUNDER', who: k => G.FOUNDER_KEYS.includes(k), from: 'Sistema', subject: '✠ Conjunto do Fundador',
    body: 'Bem-vindo, Vascaíno Supremo. Seu conjunto exclusivo, todos os veículos e a aba de testes admin estão liberados.',
    rewards: { gold: 121121, title: 'O Vascaíno Supremo', items: ['skin_fundador_tatico', 'wpk_fundador', 'ice_fundador', 'chute_uno_fundador', 'veh_uno', 'veh_moto', 'veh_truck'] } }
];
function inboxOf(key) {
  let list = mailboxes.get(key);
  if (!list) { list = []; mailboxes.set(key, list); }
  for (const c of CAMPAIGNS) if (c.who(key) && !list.some(m => m.id === c.id))
    list.unshift({ id: c.id, campaign: true, from: c.from, subject: c.subject, body: c.body, rewards: c.rewards, ts: now(), status: mailClaims.has(key + '|' + c.id) ? 'claimed' : 'new' });
  while (list.length > MAIL_MAX) { const i = list.map(m => m.status).lastIndexOf('claimed'); list.splice(i >= 0 ? i : list.length - 1, 1); }
  return list;
}
function cleanRewards(d, admin) {
  d = d || {};
  const r = {};
  const gold = Math.floor(Number(d.gold)); if (Number.isFinite(gold) && gold > 0) r.gold = Math.min(gold, admin ? MAX_GRANT : GIFT_GOLD_DAY);
  const items = (Array.isArray(d.items) ? d.items : []).map(String).filter(id => SHOP_GIFTABLE.test(id) && !G.isLimitedItem(id) && (admin || !EXCLUSIVE_ITEM_IDS.has(id))).slice(0, 10);
  if (items.length) r.items = [...new Set(items)];
  const title = cut2(d.title, 40); if (title && (admin || (!G.LIMITED_TITLES.has(title) && !G.EXCLUSIVE.title[title]))) r.title = title;
  return r;
}
const cut2 = (v, n) => (typeof v === 'string' && v.trim() ? v.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, n) : null);
function deliverMail(key, letter) {
  const list = inboxOf(key); list.unshift(letter); saveData();
  onlineSocketsOfKey(key).forEach(s => s.emit('mail:new', { id: letter.id, subject: letter.subject, unread: list.filter(m => m.status === 'new').length }));
}

/* ---------- veículos na sala (V1.2.1) ---------- */
const vehPub = v => ({ pid: v.pid, type: v.type, skin: v.skin, ladder: !!v.ladder, x: v.x, z: v.z, rot: v.rot, hp: v.hp, max: v.max, wheelie: !!v.wheelie, spd: v.spd || 0 });
function damageVehicle(r, v, dmg, byPid) {
  v.hp = Math.max(0, v.hp - dmg);
  if (v.hp > 0) return io.to(r.code).emit('vehicle:hit', { pid: v.pid, hp: v.hp, max: v.max, by: byPid || null });
  r.vehicles.delete(v.pid);
  const hits = [];
  for (const o of r.players.values()) {
    if (!o.alive || o.offline) continue;
    const d = Math.hypot(o.x - v.x, o.z - v.z); if (d > G.VEH_EXPLODE.RADIUS) continue;
    const dmgP = Math.round(G.VEH_EXPLODE.DAMAGE * (1 - d / G.VEH_EXPLODE.RADIUS * 0.7));
    o.hp = Math.max(0, o.hp - dmgP); hits.push({ pid: o.pid, hp: o.hp, dmg: dmgP });
    if (o.hp <= 0) { o.alive = false; const k = byPid && r.players.get(byPid); if (k && k.pid !== o.pid) k.kills++; }
  }
  io.to(r.code).emit('vehicle:explode', { pid: v.pid, x: v.x, z: v.z, by: byPid || null, radius: G.VEH_EXPLODE.RADIUS, hits });
  sendSnapshot(r);
  for (const h of hits) if (h.hp <= 0) onDeath(r, h.pid, byPid && byPid !== h.pid ? byPid : null);
}

/* ---------- conexão ---------- */
io.on('connection', socket => {
  // Toda falha em handler vira log + resposta de erro (nada derruba a sala nem perde o estado).
  const rawOn = socket.on.bind(socket);
  socket.on = (ev, fn) => rawOn(ev, (...args) => {
    try { return fn(...args); }
    catch (e) {
      logger.error('socket_handler_error', { event: ev, message: e && e.message, player: logger.hash(socket.data.pid || '-') });
      const cb = args[args.length - 1]; if (typeof cb === 'function') cb({ ok: false, message: 'Erro interno no servidor. Tente de novo.' });
    }
  });
  const auth = socket.handshake.auth || {};
  let pid = validPid(auth.pid) ? auth.pid : 'P-' + uid(4);
  let p = profiles.get(pid);
  let isNew = false;
  const name = cleanName(auth.name);
  if (!p) { p = { pid, name, friends: new Set(), incoming: new Set(), outgoing: new Set(), loadout: {}, stats: { w: 0, l: 0 }, sid: null, status: 'menu', verified: false, room: null, squad: null, lastChat: 0 }; profiles.set(pid, p); isNew = true; logger.info('profile_created', { player: logger.hash(pid), name }); }
  // reconexão: derruba socket antigo do mesmo jogador
  const old = sockOf(p); if (old && old.id !== socket.id) { old.data.replaced = true; old.disconnect(true); }
  p.name = name; p.sid = socket.id; p.status = p.room ? 'em partida' : 'menu';
  p.verified = !!VERIFY_CODE && auth.verify === VERIFY_CODE && VERIFIED_NICKS.includes(name.toLowerCase());
  socket.data.pid = pid; socket.data.connectedAt = now();
  logger.info('player_connected', { player: logger.hash(pid), name: p.name, returning: !isNew, verified: p.verified });
  saveData();

  socket.emit('server:hello', { version: VERSION, protocol: PROTOCOL, pid, name: p.name, verified: p.verified, history: globalChat.slice(-30) });
  // retomada de partida
  const r = p.room ? rooms.get(p.room) : null;
  if (r && r.started) {
    const pl = r.players.get(pid);
    if (pl) { clearTimeout(pl.dropTimer); pl.offline = false; socket.join(r.code); socket.data.room = r.code;
      socket.emit('match:resume', { room: r.code, kind: r.kind, players: snapshot(r), rounds: G.publicRounds(r.rounds), walls: [...(r.walls || new Map()).values()].map(wallPub), you: { x: pl.x, z: pl.z, hp: pl.hp, armor: pl.armor, alive: pl.alive } });
      io.to(r.code).emit('opponent:back', { pid }); }
  } else if (r) { socket.join(r.code); socket.data.room = r.code; }
  pushSocial(pid); pushFriendsOf(p);
  try { const ib = inboxOf(normKey(p.name)); socket.emit('mail:unread', { unread: ib.filter(m => m.status === 'new').length }); } catch (_) {}
  flushGrants(p);   // entrega o que o admin mandou enquanto o jogador estava offline

  /* --- admin: dar Bacon Coins / Tokens --- */
  socket.on('admin:grant', (data, cb) => {
    if (!isAdmin(p)) {
      logger.warn('admin_grant_denied', { player: logger.hash(pid), name: p.name, verified: p.verified });
      return reply(cb, { ok: false, message: p.verified ? 'Sua conta não é admin.' : 'Conta não verificada no servidor. Defina VERIFY_CODE no Render e digite o mesmo código no campo de verificação do jogo.' });
    }
    if (limited(socket, 'grant', 300)) return reply(cb, { ok: false, message: 'Devagar, tente de novo em um instante.' });
    const kind = data && data.kind === 'gold' ? 'gold' : data && data.kind === 'tokens' ? 'tokens' : null;
    const amount = Math.floor(Number(data && data.amount));
    const target = normKey(data && data.target);
    if (!kind || !target || !Number.isFinite(amount) || amount < 1 || amount > MAX_GRANT) return reply(cb, { ok: false, message: 'Dados inválidos (nick, tipo ou quantidade).' });
    const g = { id: uid(6), kind, amount, from: p.name, ts: now() };
    const list = grants.get(target) || []; list.push(g); if (list.length > 200) list.shift(); grants.set(target, list);
    const socks = onlineSocketsOfKey(target); socks.forEach(s => s.emit('wallet:grant', g));
    saveData();
    logger.info('admin_grant', { admin: logger.hash(pid), target, kind, amount, delivered: socks.length > 0 });
    reply(cb, { ok: true, delivered: socks.length > 0, message: socks.length ? 'Entregue agora.' : 'Jogador offline: será entregue quando ele conectar.' });
  });
  socket.on('grant:ack', data => {
    const key = normKey(p.name), list = grants.get(key); if (!list || !data) return;
    const left = list.filter(g => g.id !== data.id);
    if (left.length) grants.set(key, left); else grants.delete(key);
    saveData();
  });

  /* --- fila --- */
  socket.on('queue:join', (data, cb) => {
    data = data || {}; const kind = MODES[data.mode] ? data.mode : 'duel';
    if (limited(socket, 'queue', 600)) return fail(socket, cb, 'queue:error', 'Aguarde um instante e tente de novo.');
    if (p.room) leaveRoom(p, 'nova busca');
    dequeue(pid);
    const sq = p.squad ? squads.get(p.squad) : null;
    let pids = [pid];
    if (sq) {
      if (sq.leader !== pid) return fail(socket, cb, 'queue:error', 'Apenas o líder do esquadrão pode iniciar a busca.');
      pids = [...sq.members].filter(id => { const m = profiles.get(id); return m && m.sid && !m.room; });
      if (kind === 'duel' && pids.length > 1) return fail(socket, cb, 'queue:error', 'O 1v1 é individual. Saia do esquadrão ou use Duo/Esquadrão.');
      if (pids.length > MODES[kind].team * (MODES[kind].cap / MODES[kind].team)) pids = pids.slice(0, MODES[kind].cap);
    }
    const dmap = {}; for (const id of pids) dmap[id] = id === pid ? data : {};
    queues[kind].push({ pids, data: dmap, at: now() });
    for (const id of pids) { const m = profiles.get(id); if (m) m.status = 'na fila'; emitTo(id, 'queue:waiting', { mode: kind, message: 'Na fila de busca (' + kind + '). Aguardando outros jogadores...' }); }
    reply(cb, { ok: true, queued: true, mode: kind });
    tryMatch(kind);
    pushMany(pids);
  });
  socket.on('queue:leave', cb => { dequeue(pid); p.status = 'menu'; socket.emit('queue:left', {}); reply(cb, { ok: true }); pushSocial(pid); });

  /* --- salas privadas --- */
  socket.on('room:create', (data, cb) => {
    data = data || {};
    if (limited(socket, 'rc', 600)) return fail(socket, cb, 'room:error', 'Aguarde um instante e tente de novo.');
    dequeue(pid); if (p.room) leaveRoom(p, 'nova sala');
    const kind = MODES[data.mode] ? data.mode : 'duel';
    const r2 = createRoom(kind, p); addToRoom(r2, p, socket, data); p.status = 'em sala';
    logger.info('room_created', { player: logger.hash(pid), room: logger.hash(r2.code), mode: kind });
    socket.emit('room:created', { code: r2.code, room: roomInfo(r2) });
    reply(cb, { ok: true, code: r2.code }); broadcastRoom(r2); pushSocial(pid);
  });
  socket.on('room:join', (data, cb) => {
    data = data || {};
    const code = String(data.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (limited(socket, 'rj', 400)) return fail(socket, cb, 'room:error', 'Aguarde um instante e tente de novo.');
    if (code.length < 4) return fail(socket, cb, 'room:error', 'Código de sala inválido.');
    const r2 = rooms.get(code);
    if (!r2 || !r2.private) return fail(socket, cb, 'room:error', 'Sala não encontrada. Confira o código.');
    if (r2.started) return fail(socket, cb, 'room:error', 'A partida dessa sala já começou.');
    if (r2.players.has(pid)) { reply(cb, { ok: true, code }); return broadcastRoom(r2); }
    if (r2.players.size >= r2.cap) return fail(socket, cb, 'room:error', 'Essa sala está cheia.');
    dequeue(pid); if (p.room) leaveRoom(p, 'trocou de sala');
    addToRoom(r2, p, socket, data); p.status = 'em sala';
    logger.info('room_joined', { player: logger.hash(pid), room: logger.hash(code) });
    socket.emit('room:joined', { code, room: roomInfo(r2) });
    reply(cb, { ok: true, code }); broadcastRoom(r2); pushMany([...r2.players.keys()]);
  });
  socket.on('room:start', cb => {
    const r2 = p.room ? rooms.get(p.room) : null;
    if (!r2 || !r2.private) return fail(socket, cb, 'room:error', 'Você não está em uma sala privada.');
    if (r2.host !== pid) return fail(socket, cb, 'room:error', 'Só o dono da sala pode iniciar.');
    if (r2.players.size < 2) return fail(socket, cb, 'room:error', 'Aguarde pelo menos mais um jogador.');
    reply(cb, { ok: startRoom(r2) });
  });
  socket.on('room:leave', cb => { leaveRoom(p, 'saiu'); reply(cb, { ok: true }); });
  socket.on('match:leave', () => leaveRoom(p, 'saiu'));

  /* --- jogo --- */
  socket.on('player:state', data => {
    const r2 = p.room ? rooms.get(p.room) : null; if (!r2 || !r2.started || r2.ended) return;
    const pl = r2.players.get(pid);
    if (!pl || !data || ![data.x, data.z, data.yaw, data.pit].every(Number.isFinite)) return;
    pl.x = Math.max(-145, Math.min(145, data.x)); pl.z = Math.max(-145, Math.min(145, data.z));
    pl.yaw = data.yaw; pl.pit = Math.max(-1.4, Math.min(1.4, data.pit));
    if (data.alive === false && pl.alive) {
      const fresh = r2.rounds && now() - r2.rounds.roundStartedAt < 1500;   // pacote atrasado do round anterior
      if (!fresh && (!r2.rounds || r2.rounds.phase === 'live')) { pl.alive = false; onDeath(r2, pid, null); }
    }
    if (typeof data.skin === 'string') pl.skin = data.skin.slice(0, 24);
    pl.stateAt = now();
  });
  socket.on('player:fire', data => {
    const r2 = p.room ? rooms.get(p.room) : null; if (!r2 || !r2.started || r2.ended) return;
    const shooter = r2.players.get(pid), weapon = WEAPONS[data && data.weapon];
    if (!shooter || !shooter.alive || !weapon) return;
    if (r2.rounds && r2.rounds.phase !== 'live') return;
    const t0 = now(); if (t0 - shooter.lastShot < weapon.cooldown * 0.72) return; shooter.lastShot = t0;
    if (![data.x, data.y, data.z, data.dx, data.dy, data.dz].every(Number.isFinite)) return;
    const len = Math.hypot(data.dx, data.dy, data.dz) || 1, dx = data.dx / len, dy = data.dy / len, dz = data.dz / len;
    io.to(r2.code).emit('combat:shot', { id: pid, x: shooter.x, y: 1.4, z: shooter.z, dx, dy, dz });
    let target = null, best = weapon.range;
    for (const o of r2.players.values()) {
      if (o.pid === pid || !o.alive || o.offline || (r2.teamSize > 1 && o.team === shooter.team)) continue;
      const ox = o.x - data.x, oy = 1.0 - data.y, oz = o.z - data.z, t = ox * dx + oy * dy + oz * dz;
      if (t < 0 || t > best) continue;
      if (Math.hypot(ox - dx * t, oy - dy * t, oz - dz * t) < 0.9) { best = t; target = o; }
    }
    // veículo de outro jogador entre o atirador e o alvo leva o tiro (blindagem)
    let vehHit = null, vehT = target ? best : weapon.range;
    for (const v of (r2.vehicles || new Map()).values()) {
      if (v.pid === pid) continue;
      const vt = G.rayHitsSphere(data.x, data.y, data.z, dx, dy, dz, v.x, 0.9, v.z, G.VEHICLES[v.type].radius, vehT);
      if (vt !== null && vt < vehT) { vehT = vt; vehHit = v; }
    }
    // parede de gelo mais próxima que o alvo bloqueia o tiro e leva o dano
    let wallHit = null, wallT = vehHit ? vehT : target ? best : weapon.range;
    for (const w of (r2.walls || new Map()).values()) {
      const tw = G.rayHitsWall(data.x, data.y, data.z, dx, dy, dz, w, wallT);
      if (tw !== null && tw < wallT) { wallT = tw; wallHit = w; }
    }
    if (wallHit) {
      wallHit.hp -= G.WALL.DMG_PER_HIT;
      if (wallHit.hp <= 0) destroyWall(r2, wallHit.id, 'quebrou');
      else io.to(r2.code).emit('wall:hit', { id: wallHit.id, hp: wallHit.hp });
      return;
    }
    if (vehHit) { damageVehicle(r2, vehHit, weapon.damage * (vehHit.type === 'truck' ? 0.6 : 1), pid); return; }
    if (!target) return;
    let rem = weapon.damage * (data.weapon === 'shotgun' || data.weapon === 'm870' ? 1.4 : 1);
    if (target.armor > 0) { const a = Math.min(target.armor, rem * 0.5); target.armor -= a; rem -= a; }
    target.hp = Math.max(0, target.hp - rem);
    if (target.hp <= 0) { target.alive = false; shooter.kills++; }
    io.to(r2.code).emit('combat:health', { attacker: pid, target: target.pid, hp: target.hp, armor: target.armor, kills: shooter.kills });
    sendSnapshot(r2);
    if (!target.alive) onDeath(r2, target.pid, pid);
  });

  /* --- parede de gelo: o servidor valida, dá ID e manda para TODA a sala --- */
  socket.on('wall:place', (data, cb) => {
    const r2 = p.room ? rooms.get(p.room) : null;
    if (!r2 || !r2.started || r2.ended) return reply(cb, { ok: false, message: 'Fora de partida.' });
    const pl = r2.players.get(pid);
    if (!pl || !pl.alive || (r2.rounds && r2.rounds.phase !== 'live')) return reply(cb, { ok: false, message: 'Não pode colocar gelo agora.' });
    if (limited(socket, 'wall', 350)) return reply(cb, { ok: false, message: 'Devagar.' });
    if (!G.validWallInput(data)) { logger.warn('wall_invalid', { player: logger.hash(pid) }); return reply(cb, { ok: false, message: 'Gelo inválido.' }); }
    if (Math.hypot(data.x - pl.x, data.z - pl.z) > 12) { logger.warn('wall_too_far', { player: logger.hash(pid) }); return reply(cb, { ok: false, message: 'Gelo longe demais.' }); }
    r2.walls = r2.walls || new Map();
    const mine = [...r2.walls.values()].filter(w => w.owner === pid);
    while (mine.length >= G.WALL.MAX_PER_OWNER) destroyWall(r2, mine.shift().id, 'limite');
    if (r2.walls.size >= G.WALL.MAX_PER_ROOM) destroyWall(r2, r2.walls.keys().next().value, 'limite');
    const skin = G.sanitizeLoadout({ wall: data.skin }, refChannelOf(p), p.name).wall || 'ice_default';
    const w = { id: 'W-' + uid(4), owner: pid, x: data.x, z: data.z, rot: data.rot, rad: data.rad, arc: data.arc, skin, hp: G.WALL.HP, exp: now() + G.WALL.TTL_MS };
    r2.walls.set(w.id, w);
    io.to(r2.code).emit('wall:spawn', Object.assign(wallPub(w), { cid: data.cid || null }));
    logger.debug('wall_placed', { room: logger.hash(r2.code), player: logger.hash(pid) });
    reply(cb, { ok: true, id: w.id, ttl: G.WALL.TTL_MS });
  });
  socket.on('wall:sync', cb => {
    const r2 = p.room ? rooms.get(p.room) : null;
    reply(cb, { ok: !!r2, walls: r2 && r2.walls ? [...r2.walls.values()].map(wallPub) : [], rounds: r2 ? G.publicRounds(r2.rounds) : null });
  });

  /* --- loadout: cada jogador só define o PRÓPRIO visual (isolado por pid) --- */
  socket.on('loadout:set', (data, cb) => {
    if (limited(socket, 'lo', 250)) return reply(cb, { ok: false });
    const lo = G.sanitizeLoadout(data, refChannelOf(p), p.name);
    p.loadout = lo; saveData();
    const r2 = p.room ? rooms.get(p.room) : null, pl = r2 && r2.players.get(pid);
    if (pl) { Object.assign(pl, { skin: lo.skin || pl.skin, pack: lo.pack, wall: lo.wall, title: lo.title }); io.to(r2.code).emit('player:loadout', { pid, ...lo }); }
    reply(cb, { ok: true, loadout: lo });
  });

  /* --- correio (V1.2.1) --- */
  const myKey = () => normKey(p.name);
  const inboxPub = () => { const list = inboxOf(myKey()); return { ok: true, letters: list, unread: list.filter(m => m.status === 'new').length }; };
  socket.on('mail:get_inbox', (data, cb) => { if (typeof data === 'function') cb = data; reply(cb, inboxPub()); });
  socket.on('mail:read', (data, cb) => {
    const m = inboxOf(myKey()).find(x => x.id === String(data && data.id)); if (m && m.status === 'new') { m.status = 'read'; saveData(); }
    reply(cb, inboxPub());
  });
  socket.on('mail:claim_reward', (data, cb) => {
    if (limited(socket, 'mclaim', 600)) return reply(cb, { ok: false, message: 'Aguarde um instante.' });
    const key = myKey(), m = inboxOf(key).find(x => x.id === String(data && data.id));
    if (!m) return reply(cb, { ok: false, message: 'Carta não encontrada.' });
    if (m.status === 'claimed') return reply(cb, { ok: false, already: true, message: 'Essa recompensa já foi resgatada.' });
    if (m.campaign) {
      if (mailClaims.has(key + '|' + m.id)) { m.status = 'claimed'; saveData(); return reply(cb, { ok: false, already: true, message: 'Essa conta já resgatou.' }); }
      if (mailClaims.has(pid + '|' + m.id)) return reply(cb, { ok: false, message: 'Este aparelho já resgatou essa recompensa.' });
      mailClaims.add(key + '|' + m.id); mailClaims.add(pid + '|' + m.id);
    }
    m.status = 'claimed'; m.claimedAt = now(); saveData();
    logger.info('mail_claimed', { player: logger.hash(pid), letter: m.id });
    reply(cb, { ok: true, id: m.id, claimId: m.id + ':' + key, rewards: m.rewards || {}, ...inboxPub() });
  });
  socket.on('mail:send', (data, cb) => {
    if (limited(socket, 'msend', 3000)) return reply(cb, { ok: false, message: 'Aguarde alguns segundos para enviar outro presente.' });
    data = data || {};
    const admin = isAdmin(p) || (G.isFounderKey(p.name) && p.verified);
    let to = normKey(data.to);
    if (/^P-/i.test(String(data.to || ''))) { const tp = profiles.get(String(data.to)); to = tp ? normKey(tp.name) : ''; }
    if (!to || to.length > 24) return reply(cb, { ok: false, message: 'Nick ou ID inválido.' });
    if (to === myKey()) return reply(cb, { ok: false, message: 'Não dá pra mandar presente pra você mesmo.' });
    const known = [...profiles.values()].some(x => normKey(x.name) === to) || mailboxes.has(to);
    if (!known && !admin) return reply(cb, { ok: false, message: 'Jogador não encontrado (ele precisa ter entrado no online pelo menos uma vez).' });
    const rewards = cleanRewards(data, admin);
    if (!rewards.gold && !rewards.items && !rewards.title) return reply(cb, { ok: false, message: 'Escolha um presente válido.' });
    if (rewards.gold && !admin) {
      const day = new Date().toISOString().slice(0, 10), gl = giftLog.get(pid) || { day, gold: 0 };
      if (gl.day !== day) { gl.day = day; gl.gold = 0; }
      if (gl.gold + rewards.gold > GIFT_GOLD_DAY) return reply(cb, { ok: false, message: 'Limite diário de presentes em moedas atingido.' });
      gl.gold += rewards.gold; giftLog.set(pid, gl);
    }
    const letter = { id: 'M-' + uid(6), from: p.name, subject: '🎁 Presente de ' + p.name, body: cut2(data.message, 200) || 'Você recebeu um presente!', rewards, ts: now(), status: 'new' };
    deliverMail(to, letter);
    logger.info('mail_sent', { from: logger.hash(pid), to, admin, gold: rewards.gold || 0, items: (rewards.items || []).length });
    reply(cb, { ok: true, message: 'Presente enviado!', cost: admin ? 0 : (rewards.gold || 0) });
  });

  /* --- veículos (V1.2.1): estado autoritativo de HP e explosão no servidor --- */
  socket.on('vehicle:spawn', (data, cb) => {
    const r2 = p.room ? rooms.get(p.room) : null; data = data || {};
    if (!r2 || !r2.started || r2.ended) return reply(cb, { ok: false, message: 'Fora de partida.' });
    const pl = r2.players.get(pid), spec = G.VEHICLES[data.type];
    if (!pl || !pl.alive || !spec) return reply(cb, { ok: false, message: 'Não pode chamar veículo agora.' });
    if (limited(socket, 'vsp', 4000)) return reply(cb, { ok: false, message: 'Espere para chamar outro veículo.' });
    r2.vehicles = r2.vehicles || new Map();
    const v = { pid, type: data.type, skin: cut2(data.skin, 24) || 'padrao', ladder: !!data.ladder, x: pl.x, z: pl.z, rot: Number.isFinite(data.rot) ? data.rot : 0, hp: spec.hp, max: spec.hp, at: now() };
    r2.vehicles.set(pid, v);
    io.to(r2.code).emit('vehicle:spawn', vehPub(v));
    reply(cb, { ok: true, vehicle: vehPub(v) });
  });
  socket.on('vehicle:state', data => {
    const r2 = p.room ? rooms.get(p.room) : null, v = r2 && r2.vehicles && r2.vehicles.get(pid);
    if (!v || !data || ![data.x, data.z, data.rot].every(Number.isFinite)) return;
    const spec = G.VEHICLES[v.type], dt = Math.max(0.03, (now() - (v.at || now())) / 1000);
    if (Math.hypot(data.x - v.x, data.z - v.z) > spec.maxSpeed * 1.6 * dt + 2) return; // anti-teleporte
    v.x = Math.max(-145, Math.min(145, data.x)); v.z = Math.max(-145, Math.min(145, data.z)); v.rot = data.rot; v.at = now();
    v.wheelie = !!data.wheelie; v.spd = Number.isFinite(data.spd) ? Math.max(-12, Math.min(40, data.spd)) : 0;
    socket.to(r2.code).emit('vehicle:state', vehPub(v));
  });
  socket.on('vehicle:crash', data => {   // colisão forte: dano no próprio veículo (moto empinada sofre mais)
    const r2 = p.room ? rooms.get(p.room) : null, v = r2 && r2.vehicles && r2.vehicles.get(pid);
    if (!v || limited(socket, 'vcr', 400)) return;
    const sp = Math.max(0, Math.min(40, Number(data && data.speed) || 0));
    const mult = v.type === 'moto' ? (data && data.wheelie ? 2.2 : 1.4) : v.type === 'truck' ? 0.25 : 1;
    if (sp > 6) damageVehicle(r2, v, Math.round(sp * 2.2 * mult), null);
  });
  socket.on('vehicle:ram', data => {     // atropelamento/empurrão do caminhão, validado por distância
    const r2 = p.room ? rooms.get(p.room) : null, v = r2 && r2.vehicles && r2.vehicles.get(pid);
    if (!v || limited(socket, 'vram', 500)) return;
    const o = r2.players.get(String(data && data.target)); if (!o || !o.alive || o.pid === pid || (r2.teamSize > 1 && o.team === (r2.players.get(pid) || {}).team)) return;
    if (Math.hypot(o.x - v.x, o.z - v.z) > G.VEHICLES[v.type].radius + 2.5) return;
    const sp = Math.max(0, Math.min(40, Number(data.speed) || 0)); if (sp < 8) return;
    const dmg = Math.round(sp * (v.type === 'truck' ? 1.8 : v.type === 'uno' ? 1.1 : 0.8));
    o.hp = Math.max(0, o.hp - dmg); const shooter = r2.players.get(pid);
    if (o.hp <= 0) { o.alive = false; shooter.kills++; }
    io.to(r2.code).emit('vehicle:rammed', { by: pid, target: o.pid, dmg, push: v.type === 'truck' ? 9 : 4, rot: v.rot });
    io.to(r2.code).emit('combat:health', { attacker: pid, target: o.pid, hp: o.hp, armor: o.armor, kills: shooter.kills });
    sendSnapshot(r2); if (!o.alive) onDeath(r2, o.pid, pid);
  });
  socket.on('vehicle:leave', () => {
    const r2 = p.room ? rooms.get(p.room) : null;
    if (r2 && r2.vehicles && r2.vehicles.delete(pid)) io.to(r2.code).emit('vehicle:leave', { pid });
  });
  socket.on('vehicle:sync', cb => {
    const r2 = p.room ? rooms.get(p.room) : null;
    reply(cb, { ok: !!r2, vehicles: r2 && r2.vehicles ? [...r2.vehicles.values()].map(vehPub) : [] });
  });

  socket.on('vehicle:horn', data => {   // V1.2.1: buzina ouvida pelos outros jogadores da sala
    const r2 = p.room ? rooms.get(p.room) : null; if (!r2 || limited(socket, 'vhorn', 350)) return;
    const v = r2.vehicles && r2.vehicles.get(pid), pl = r2.players.get(pid); if (!pl) return;
    const type = v ? v.type : (G.VEHICLES[data && data.type] ? data.type : 'uno');
    socket.to(r2.code).emit('vehicle:horn', { pid, type, x: v ? v.x : pl.x, z: v ? v.z : pl.z });
  });

  /* --- indicação de conta nova (YouTube) --- */
  socket.on('referral:status', (data, cb) => {
    const rec = referrals.get(G.normKey(data && data.account));
    reply(cb, { ok: true, claimed: !!rec, record: rec || null, deviceUsed: refByPid.has(pid) && !rec });
  });
  socket.on('referral:claim', (data, cb) => {
    if (limited(socket, 'ref', 1500)) return reply(cb, { ok: false, message: 'Aguarde um instante.' });
    const acc = G.normKey(data && data.account);
    if (!acc) return reply(cb, { ok: false, message: 'Conta inválida para indicação.' });
    if (referrals.has(acc)) return reply(cb, { ok: false, already: true, record: referrals.get(acc), message: 'Essa conta já resgatou a indicação.' });
    if (refByPid.has(pid)) return reply(cb, { ok: false, message: 'Este aparelho já resgatou uma indicação.' });
    let channel = null; try { channel = G.normalizeChannel(String((data && data.input) || '')); } catch (e) { logger.warn && logger.warn('referral_parse', { err: String(e) }); }
    if (!channel) return reply(cb, { ok: false, message: 'Canal não reconhecido. Use @baconvascaino121 ou @sunaura69clips.' });
    const R = G.REFERRALS[channel];
    const rec = { account: acc, pid, channel, input: String(data.input).slice(0, 120), grantId: 'REF-' + uid(5), ts: now(),
      rewards: { gold: R.gold, items: R.items.slice(), title: R.title } };
    referrals.set(acc, rec); refByPid.set(pid, acc); saveData();
    logger.info('referral_claimed', { player: logger.hash(pid), channel });
    reply(cb, { ok: true, record: rec });
  });

  /* --- loja: itens limitados não podem ser comprados --- */
  socket.on('shop:validate', (data, cb) => {
    const id = String(data && data.id || '');
    if (G.isLimitedItem(id)) { logger.warn('shop_limited_blocked', { player: logger.hash(pid), id }); return reply(cb, { ok: false, message: 'Item limitado: só por indicação.' }); }
    reply(cb, { ok: true });
  });
  const tick = setInterval(() => { const r2 = p.room ? rooms.get(p.room) : null; if (r2 && r2.started && !r2.ended) sendSnapshot(r2); }, 66);
  socket.on('ping:fnb', cb => reply(cb, { t: now() }));

  /* --- amizades --- */
  socket.on('friend:add', (data, cb) => {
    if (limited(socket, 'fa', 700)) return;
    const t = findByNameOrId(data && data.target);
    if (!t) return fail(socket, cb, 'social:error', 'Jogador não encontrado. Ele precisa ter entrado no servidor ao menos uma vez.');
    if (t.pid === pid) return fail(socket, cb, 'social:error', 'Você não pode adicionar a si mesmo.');
    if (p.friends.has(t.pid)) return fail(socket, cb, 'social:error', 'Vocês já são amigos.');
    if (p.incoming.has(t.pid)) { // já havia pedido dele: aceita
      p.incoming.delete(t.pid); t.outgoing.delete(pid); p.friends.add(t.pid); t.friends.add(pid);
      logger.info('friend_added', { player: logger.hash(pid), friend: logger.hash(t.pid) });
    } else { p.outgoing.add(t.pid); t.incoming.add(pid); emitTo(t.pid, 'friend:request', { from: pub(p) }); }
    saveData(); reply(cb, { ok: true }); pushMany([pid, t.pid]);
  });
  socket.on('friend:accept', (data, cb) => {
    const t = profiles.get(data && data.pid); if (!t || !p.incoming.has(t.pid)) return fail(socket, cb, 'social:error', 'Pedido não encontrado.');
    p.incoming.delete(t.pid); t.outgoing.delete(pid); p.friends.add(t.pid); t.friends.add(pid);
    logger.info('friend_added', { player: logger.hash(pid), friend: logger.hash(t.pid) });
    saveData(); reply(cb, { ok: true }); pushMany([pid, t.pid]);
  });
  socket.on('friend:decline', (data, cb) => {
    const t = profiles.get(data && data.pid); if (!t) return reply(cb, { ok: false });
    p.incoming.delete(t.pid); t.outgoing.delete(pid); saveData(); reply(cb, { ok: true }); pushMany([pid, t.pid]);
  });
  socket.on('friend:remove', (data, cb) => {
    const t = profiles.get(data && data.pid); if (!t) return reply(cb, { ok: false });
    p.friends.delete(t.pid); t.friends.delete(pid); saveData(); reply(cb, { ok: true }); pushMany([pid, t.pid]);
  });

  /* --- chat --- */
  socket.on('chat:global', (data, cb) => {
    const text = cleanText(data && data.text); if (!text) return;
    if (limited(socket, 'chat', 700)) return fail(socket, cb, 'social:error', 'Devagar! Aguarde um instante para enviar outra mensagem.');
    const msg = { id: uid(3), from: pub(p), text, t: now() };
    globalChat.push(msg); if (globalChat.length > 100) globalChat.shift();
    io.emit('chat:global', msg); reply(cb, { ok: true });
  });
  socket.on('chat:private', (data, cb) => {
    const t = profiles.get(data && data.to), text = cleanText(data && data.text); if (!text) return;
    if (!t || !p.friends.has(t.pid)) return fail(socket, cb, 'social:error', 'Só é possível conversar em privado com amigos.');
    if (limited(socket, 'pchat', 500)) return;
    const msg = { id: uid(3), from: pub(p), to: t.pid, text, t: now() };
    const key = [pid, t.pid].sort().join('|'); const arr = privateChat.get(key) || []; arr.push(msg); if (arr.length > 50) arr.shift(); privateChat.set(key, arr);
    socket.emit('chat:private', msg); emitTo(t.pid, 'chat:private', msg); reply(cb, { ok: true });
  });
  socket.on('chat:history', (data, cb) => {
    const key = [pid, String(data && data.with)].sort().join('|'); reply(cb, { ok: true, messages: privateChat.get(key) || [] });
  });

  /* --- convites e esquadrões --- */
  function sendInvite(kind, toPid, cb) {
    const t = profiles.get(toPid);
    if (!t || !p.friends.has(toPid)) return fail(socket, cb, 'social:error', 'Convide apenas amigos.');
    if (!t.sid) return fail(socket, cb, 'social:error', t.name + ' está offline.');
    let code = null;
    if (kind === 'match') {
      let r2 = p.room ? rooms.get(p.room) : null;
      if (!r2 || !r2.private || r2.started) { dequeue(pid); if (p.room) leaveRoom(p, 'convite'); r2 = createRoom('duel', p); addToRoom(r2, p, socket, {}); p.status = 'em sala'; socket.emit('room:created', { code: r2.code, room: roomInfo(r2) }); }
      if (r2.players.size >= r2.cap) return fail(socket, cb, 'social:error', 'Sua sala está cheia.');
      code = r2.code;
    } else {
      if (!p.squad) { const id = 'S-' + uid(3); squads.set(id, { id, leader: pid, members: new Set([pid]) }); p.squad = id; }
      const sq = squads.get(p.squad);
      if (sq.leader !== pid) return fail(socket, cb, 'social:error', 'Só o líder pode convidar.');
      if (sq.members.size >= 4) return fail(socket, cb, 'social:error', 'Esquadrão cheio (máx. 4).');
      if (t.squad === sq.id) return fail(socket, cb, 'social:error', 'Já está no esquadrão.');
    }
    const id = 'I-' + uid(4);
    invites.set(id, { id, kind, from: pid, to: toPid, code, exp: now() + INVITE_MS });
    emitTo(toPid, 'invite:received', { id, kind, from: pub(p), code });
    reply(cb, { ok: true }); pushMany([pid, toPid]);
  }
  socket.on('invite:match', (d, cb) => sendInvite('match', d && d.to, cb));
  socket.on('squad:invite', (d, cb) => sendInvite('squad', d && d.to, cb));
  socket.on('invite:respond', (data, cb) => {
    const inv = invites.get(data && data.id);
    if (!inv || inv.to !== pid || inv.exp < now()) return fail(socket, cb, 'social:error', 'Convite expirado.');
    invites.delete(inv.id);
    if (!data.accept) { emitTo(inv.from, 'invite:declined', { by: pub(p), kind: inv.kind }); reply(cb, { ok: true }); return pushMany([pid, inv.from]); }
    if (inv.kind === 'match') {
      const r2 = rooms.get(inv.code);
      if (!r2 || r2.started || r2.players.size >= r2.cap) return fail(socket, cb, 'room:error', 'A sala do convite não está mais disponível.');
      dequeue(pid); if (p.room) leaveRoom(p, 'convite'); addToRoom(r2, p, socket, data); p.status = 'em sala';
      socket.emit('room:joined', { code: r2.code, room: roomInfo(r2) }); broadcastRoom(r2);
    } else {
      const sq = (profiles.get(inv.from) || {}).squad ? squads.get(profiles.get(inv.from).squad) : null;
      if (!sq || sq.members.size >= 4) return fail(socket, cb, 'social:error', 'O esquadrão não está mais disponível.');
      if (p.squad) leaveSquad(p); sq.members.add(pid); p.squad = sq.id; pushMany([...sq.members]);
    }
    reply(cb, { ok: true }); pushMany([pid, inv.from]);
  });
  socket.on('squad:leave', cb => { leaveSquad(p); reply(cb, { ok: true }); });

  /* --- desconexão --- */
  socket.on('disconnect', () => {
    clearInterval(tick);
    if (socket.data.replaced) return;           // substituído por reconexão do mesmo jogador
    dequeue(pid);
    logger.info('player_disconnected', { player: logger.hash(pid), name: p.name, online_s: Math.round((now() - (socket.data.connectedAt || now())) / 1000) });
    p.sid = null; p.status = 'offline';
    const r2 = p.room ? rooms.get(p.room) : null;
    if (r2 && r2.started && !r2.ended) {
      const pl = r2.players.get(pid);
      if (pl) {
        pl.offline = true;
        io.to(r2.code).emit('opponent:offline', { pid, name: p.name, graceMs: GRACE_MS });
        pl.dropTimer = setTimeout(() => { if (profiles.get(pid) && !profiles.get(pid).sid) leaveRoom(p, 'desconectou'); }, GRACE_MS);
        if (pl.dropTimer.unref) pl.dropTimer.unref();
      }
    } else if (r2) leaveRoom(p, 'desconectou');
    leaveSquad(p);
    pushFriendsOf(p);
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => { console.log('Fogo Nos Bacon — servidor ' + VERSION + ' (protocolo ' + PROTOCOL + ') na porta ' + PORT); logger.info('server_started', { version: VERSION, port: Number(PORT) }); });
}
module.exports = { server, io, rooms, queues, profiles, squads, PROTOCOL, VERSION };
