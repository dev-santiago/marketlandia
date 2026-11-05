const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
// No Render, aponte DB_PATH para um disco persistente (ex.: /var/data/erp.db),
// senão o banco é apagado a cada deploy/reinício.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'erp.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!process.env.DB_PATH) console.warn('AVISO: DB_PATH não definido. O banco fica em disco temporário e é APAGADO a cada reinício/deploy no Render.');

const app = express();
const db = new sqlite3.Database(DB_PATH);

app.use(express.json({ limit: '50mb' }));

// ---------- helpers com Promise ----------
const run = (sql, params = []) => new Promise((resolve, reject) =>
  db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
const get = (sql, params = []) => new Promise((resolve, reject) =>
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));

const n = v => (v === undefined || v === '' || Number.isNaN(v) ? null : v);
const num = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const str = v => (v === undefined || v === null ? null : String(v));
const flag = v => (v === 0 || v === false || v === '0' ? 0 : 1);

// ---------- criação das tabelas ----------
// "store" guarda o JSON completo (é a fonte da verdade que o sistema lê).
// As demais tabelas são um espelho relacional, recriadas a cada gravação.
const MIRROR_TABLES = {
  usuarios: `CREATE TABLE usuarios (id TEXT PRIMARY KEY, nome TEXT, email TEXT, senha_hash TEXT, role TEXT, pct REAL, ativo INTEGER)`,
  clientes: `CREATE TABLE clientes (id TEXT PRIMARY KEY, cod_sis TEXT, tipo TEXT, nome TEXT, fantasia TEXT, doc TEXT, ie TEXT, email TEXT, tel TEXT, log TEXT, num TEXT, bairro TEXT, cid TEXT, uf TEXT, cep TEXT, vend TEXT, ativo INTEGER)`,
  produtos: `CREATE TABLE produtos (id TEXT PRIMARY KEY, cod_int TEXT, sku TEXT, nome TEXT, un TEXT, custo REAL, preco REAL, est REAL, cat TEXT, marca TEXT, ativo INTEGER)`,
  orcamentos: `CREATE TABLE orcamentos (id TEXT PRIMARY KEY, n TEXT, cli TEXT, vend TEXT, vend_nome TEXT, data INTEGER, frete REAL, parc INTEGER, st TEXT, ped TEXT, itens TEXT)`,
  pedidos: `CREATE TABLE pedidos (id TEXT PRIMARY KEY, n TEXT, orc TEXT, cli TEXT, vend TEXT, vend_nome TEXT, data INTEGER, frete REAL, parc INTEGER, st TEXT, itens TEXT)`
};

const ready = (async () => {
  await run(`CREATE TABLE IF NOT EXISTS store (id INTEGER PRIMARY KEY, data TEXT)`);
  for (const [name, ddl] of Object.entries(MIRROR_TABLES)) {
    // tabelas antigas tinham outro formato; como são só espelho, recriar é seguro
    await run(`DROP TABLE IF EXISTS ${name}`);
    await run(ddl);
  }
})().catch(err => { console.error('Falha ao preparar o banco:', err); process.exit(1); });

// ---------- gravação do espelho (dentro de uma transação) ----------
async function writeMirror(d) {
  for (const t of Object.keys(MIRROR_TABLES)) await run(`DELETE FROM ${t}`);

  const seen = new Set();
  const uniq = (list) => (Array.isArray(list) ? list : []).filter(x => {
    if (!x || !x.id || seen.has(x._k + x.id)) return false;
    seen.add(x._k + x.id);
    return true;
  });
  const tag = (list, k) => (Array.isArray(list) ? list : []).map(x => (x ? Object.assign({}, x, { _k: k }) : x));

  for (const u of uniq(tag(d.users, 'u')))
    await run(`INSERT OR REPLACE INTO usuarios VALUES (?,?,?,?,?,?,?)`,
      [u.id, str(u.nome), str(u.email), str(u.h), str(u.role), num(u.pct), flag(u.ativo)]);

  for (const c of uniq(tag(d.cli, 'c')))
    await run(`INSERT OR REPLACE INTO clientes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c.id, str(c.codSis), str(c.tipo), str(c.nome), str(c.fantasia), str(c.doc), str(c.ie), str(c.email),
       str(c.tel), str(c.log), str(c.num), str(c.bairro), str(c.cid), str(c.uf), str(c.cep), str(c.vend), flag(c.ativo)]);

  for (const p of uniq(tag(d.prod, 'p')))
    await run(`INSERT OR REPLACE INTO produtos VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [p.id, str(p.codInt), str(p.sku), str(p.nome), str(p.un), num(p.custo), num(p.preco), num(p.est),
       str(p.cat), str(p.marca), flag(p.ativo)]);

  for (const o of uniq(tag(d.orc, 'o')))
    await run(`INSERT OR REPLACE INTO orcamentos VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [o.id, str(o.n), str(o.cli), str(o.vend), str(o.vendNome), num(o.data), num(o.frete), num(o.parc),
       str(o.st), str(o.ped), JSON.stringify(o.itens || [])]);

  for (const p of uniq(tag(d.ped, 'd')))
    await run(`INSERT OR REPLACE INTO pedidos VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [p.id, str(p.n), str(p.orc), str(p.cli), str(p.vend), str(p.vendNome), num(p.data), num(p.frete),
       num(p.parc), str(p.st), JSON.stringify(p.itens || [])]);
}

// ---------- API ----------
app.get('/api/db', async (req, res) => {
  try {
    await ready;
    const row = await get(`SELECT data FROM store WHERE id = 1`);
    res.json(row ? JSON.parse(row.data) : null);
  } catch (err) {
    console.error('Erro ao ler o banco:', err);
    res.status(500).json({ ok: false, erro: 'Falha ao ler o banco de dados.' });
  }
});

// Grava uma por vez (evita duas gravações simultâneas embaralharem a transação)
let fila = Promise.resolve();

app.post('/api/db', (req, res) => {
  const d = req.body;
  if (!d || typeof d !== 'object' || !Array.isArray(d.users)) {
    return res.status(400).json({ ok: false, erro: 'Dados inválidos.' });
  }

  // O botão "Excluir todos os logins" do sistema envia este cabeçalho para confirmar
  // que apagar todos os usuários é intencional.
  const apagarLoginsConfirmado = req.get('X-Confirm-Wipe-Users') === 'sim';

  fila = fila.then(async () => {
    await ready;
    const atual = await get(`SELECT data FROM store WHERE id = 1`);
    let antigo = null;
    if (atual) { try { antigo = JSON.parse(atual.data); } catch (e) { /* JSON corrompido: deixa sobrescrever */ } }
    const revAtual = antigo && Number.isInteger(antigo._rev) ? antigo._rev : 0;

    if (antigo && Array.isArray(antigo.users) && antigo.users.length > 0) {
      // nunca trocar uma base com usuários por uma vazia (a menos que seja confirmado)
      if (d.users.length === 0 && !apagarLoginsConfirmado) {
        return res.status(409).json({ ok: false, erro: 'Gravação recusada: base sem usuários sobrescreveria dados existentes.' });
      }
      // quem grava precisa ter partido da versão atual; cópia velha de outra aba/aparelho não sobrescreve mais
      if (d._rev !== revAtual && !apagarLoginsConfirmado) {
        return res.status(409).json({ ok: false, conflito: true, rev: revAtual, erro: 'Dados desatualizados: outra pessoa gravou antes.' });
      }
    }
    d._rev = revAtual + 1;

    await run('BEGIN');
    try {
      await run(`INSERT OR REPLACE INTO store (id, data) VALUES (1, ?)`, [JSON.stringify(d)]);
      await writeMirror(d);
      await run('COMMIT');
      res.json({ ok: true, rev: d._rev });
    } catch (err) {
      await run('ROLLBACK').catch(() => {});
      throw err;
    }
  }).catch(err => {
    console.error('Erro ao gravar o banco:', err);
    if (!res.headersSent) res.status(500).json({ ok: false, erro: 'Falha ao gravar no banco de dados.' });
  });
});

// Serve só a página do sistema (não expõe erp.db nem server.js)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'projeto1.html'));
});

process.on('unhandledRejection', err => console.error('unhandledRejection:', err));

app.listen(PORT, '0.0.0.0', () => console.log(`Servidor rodando na porta ${PORT} (banco: ${DB_PATH})`));
