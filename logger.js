'use strict';
/* Logger de eventos do Fogo Nos Bacon.
   Escreve 1 linha JSON por evento no stdout -> o Render guarda e deixa pesquisar. */
const crypto = require('crypto');

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
