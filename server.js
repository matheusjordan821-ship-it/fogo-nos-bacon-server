'use strict';
/* Fogo Nos Bacon — servidor multiplayer V1.0.0 Beta Pública (protocolo 2)
   Matchmaking 1v1, salas privadas, reconexão, amigos, chat, convites e esquadrões. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const logger = require('./logger');   // logs de eventos (JSON)

const VERSION = '1.0.0-beta-publica';
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
const grants = new Map();     // nick normalizado -> [{ id, kind:'tokens'|'gold', amount, from, ts }] (entregues até o jogador confirmar)

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
    for (const p of raw.profiles || []) profiles.set(p.pid, { pid: p.pid, name: p.name, friends: new Set(p.friends), incoming: new Set(p.incoming), outgoing: new Set(p.outgoing), sid: null, status: 'offline', verified: false, room: null, squad: null, lastChat: 0 });
    for (const [k, list] of Object.entries(raw.grants || {})) if (Array.isArray(list) && list.length) grants.set(k, list);
  } catch (_) { /* primeira execução */ }
}
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const out = { profiles: [...profiles.values()].map(p => ({ pid: p.pid, name: p.name, friends: [...p.friends], incoming: [...p.incoming], outgoing: [...p.outgoing] })) };
      out.grants = Object.fromEntries(grants);
      fs.writeFileSync(DATA_FILE, JSON.stringify(out));
    } catch (_) { /* ignora */ }
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
function newPlayer(p, extra = {}) {
  return Object.assign({ pid: p.pid, id: p.pid, name: p.name, verified: !!p.verified, skin: null, ch: 'sentinel', team: 0,
    x: 0, z: 0, yaw: 0, pit: 0, hp: 100, armor: 0, kills: 0, alive: true, lastShot: 0, offline: false, dropTimer: null }, extra);
}
function createRoom(kind, host) {
  let code = makeCode(); while (rooms.has(code)) code = makeCode();
  const m = MODES[kind] || MODES.duel;
  const r = { code, kind, cap: m.cap, teamSize: m.team, host: host ? host.pid : null, players: new Map(), started: false, createdAt: now(), private: !!host };
  rooms.set(code, r); return r;
}
function addToRoom(r, p, socket, data = {}) {
  const pl = newPlayer(p, { skin: typeof data.skin === 'string' ? data.skin.slice(0, 24) : null, ch: typeof data.ch === 'string' ? data.ch.slice(0, 24) : 'sentinel' });
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
  logger.info('match_started', { room: logger.hash(r.code), mode: r.kind, players: r.players.size });
  const list = [...r.players.values()];
  const radius = 20 + list.length * 3;
  list.forEach((pl, i) => {
    const a = (i / list.length) * Math.PI * 2;
    pl.x = Math.cos(a) * radius; pl.z = Math.sin(a) * radius; pl.yaw = Math.atan2(pl.x, pl.z) + Math.PI;
    pl.hp = 100; pl.armor = 0; pl.alive = true; pl.kills = 0;
  });
  io.to(r.code).emit('match:ready', {
    room: r.code, kind: r.kind, you: null,
    players: list.map(pl => ({ id: pl.pid, pid: pl.pid, name: pl.name, verified: pl.verified, skin: pl.skin, ch: pl.ch, team: pl.team, spawn: { x: pl.x, z: pl.z, yaw: pl.yaw } }))
  });
  for (const pl of list) { const p = profiles.get(pl.pid); if (p) p.status = 'em partida'; }
  pushMany(list.map(pl => pl.pid));
  sendSnapshot(r);
  return true;
}
function snapshot(r) { return [...r.players.values()].map(p => ({ id: p.pid, name: p.name, verified: p.verified, skin: p.skin, ch: p.ch, team: p.team, x: p.x, z: p.z, yaw: p.yaw, pit: p.pit, hp: p.hp, alive: p.alive && !p.offline })); }
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
  r.players.delete(p.pid); p.room = null; p.status = 'menu';
  if (r.players.size === 0) { rooms.delete(r.code); }
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

/* ---------- conexão ---------- */
io.on('connection', socket => {
  const auth = socket.handshake.auth || {};
  let pid = validPid(auth.pid) ? auth.pid : 'P-' + uid(4);
  let p = profiles.get(pid);
  let isNew = false;
  const name = cleanName(auth.name);
  if (!p) { p = { pid, name, friends: new Set(), incoming: new Set(), outgoing: new Set(), sid: null, status: 'menu', verified: false, room: null, squad: null, lastChat: 0 }; profiles.set(pid, p); isNew = true; logger.info('profile_created', { player: logger.hash(pid), name }); }
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
      socket.emit('match:resume', { room: r.code, kind: r.kind, players: snapshot(r), you: { x: pl.x, z: pl.z, hp: pl.hp, armor: pl.armor, alive: pl.alive } });
      io.to(r.code).emit('opponent:back', { pid }); }
  } else if (r) { socket.join(r.code); socket.data.room = r.code; }
  pushSocial(pid); pushFriendsOf(p);
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
    if (data.alive === false) pl.alive = false;
    if (typeof data.skin === 'string') pl.skin = data.skin.slice(0, 24);
    pl.stateAt = now();
  });
  socket.on('player:fire', data => {
    const r2 = p.room ? rooms.get(p.room) : null; if (!r2 || !r2.started || r2.ended) return;
    const shooter = r2.players.get(pid), weapon = WEAPONS[data && data.weapon];
    if (!shooter || !shooter.alive || !weapon) return;
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
    if (!target) return;
    let rem = weapon.damage * (data.weapon === 'shotgun' || data.weapon === 'm870' ? 1.4 : 1);
    if (target.armor > 0) { const a = Math.min(target.armor, rem * 0.5); target.armor -= a; rem -= a; }
    target.hp = Math.max(0, target.hp - rem);
    if (target.hp <= 0) { target.alive = false; shooter.kills++; }
    io.to(r2.code).emit('combat:health', { attacker: pid, target: target.pid, hp: target.hp, armor: target.armor, kills: shooter.kills });
    sendSnapshot(r2);
    if (!target.alive) checkEnd(r2, pid);
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
