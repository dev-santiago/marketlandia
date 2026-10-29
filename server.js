const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const db = new sqlite3.Database('./erp.db');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS store (id INTEGER PRIMARY KEY, data TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (id TEXT PRIMARY KEY, nome TEXT, email TEXT, role TEXT, pct REAL, ativo INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS produtos (id TEXT PRIMARY KEY, sku TEXT, nome TEXT, un TEXT, custo REAL, preco REAL, est INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS orcamentos (id TEXT PRIMARY KEY, n TEXT, cli TEXT, vend TEXT, data INTEGER, frete REAL, parc INTEGER, st TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS pedidos (id TEXT PRIMARY KEY, n TEXT, orc TEXT, cli TEXT, vend TEXT, data INTEGER, frete REAL, parc INTEGER, st TEXT)`);
});

app.get('/api/db', (req, res) => {
  db.get(`SELECT data FROM store WHERE id = 1`, (err, row) => {
    res.json(row ? JSON.parse(row.data) : null);
  });
});

app.post('/api/db', (req, res) => {
  const d = req.body;
  db.serialize(() => {
    db.run(`INSERT OR REPLACE INTO store (id, data) VALUES (1, ?)`, [JSON.stringify(d)]);

    db.run(`DELETE FROM usuarios`);
    const uStmt = db.prepare(`INSERT INTO usuarios VALUES (?, ?, ?, ?, ?, ?)`);
    (d.users || []).forEach(u => uStmt.run(u.id, u.nome, u.email, u.role, u.pct, u.ativo));
    uStmt.finalize();

    db.run(`DELETE FROM produtos`);
    const pStmt = db.prepare(`INSERT INTO produtos VALUES (?, ?, ?, ?, ?, ?, ?)`);
    (d.prod || []).forEach(p => pStmt.run(p.id, p.sku, p.nome, p.un, p.custo, p.preco, p.est));
    pStmt.finalize();

    db.run(`DELETE FROM orcamentos`);
    const oStmt = db.prepare(`INSERT INTO orcamentos VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    (d.orc || []).forEach(o => oStmt.run(o.id, o.n, o.cli, o.vend, o.data, o.frete, o.parc, o.st));
    oStmt.finalize();

    db.run(`DELETE FROM pedidos`);
    const pedStmt = db.prepare(`INSERT INTO pedidos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (d.ped || []).forEach(p => pedStmt.run(p.id, p.n, p.orc, p.cli, p.vend, p.data, p.frete, p.parc, p.st));
    pedStmt.finalize();
  });
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'projeto1.html'));
});

app.listen(3000, () => console.log('http://localhost:3000'));