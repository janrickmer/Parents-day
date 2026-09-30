// Startet den Briefkasten-Dienst (worker/briefkasten.js) lokal für Tests – mit einer D1-Nachbildung
// auf Basis von node:sqlite (In-Memory-Datenbank).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/briefkasten.js';

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  allSync() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.params), meta: { changes: 0 } };
  }
  runSync() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes) } };
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async all() {
    return this.allSync();
  }
  async run() {
    return this.runSync();
  }
}

/** Minimale Nachbildung der D1-Schnittstelle (prepare/bind/first/all/run/batch). */
export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  /** Wie bei D1: alle Anweisungen in einer Transaktion; SELECT liefert `results`. */
  async batch(statements) {
    const results = [];
    this.db.exec('BEGIN');
    try {
      // synchron – so kann keine andere Anfrage mitten in die Transaktion geraten
      for (const st of statements) results.push(/^\s*select|\breturning\b/i.test(st.sql) ? st.allSync() : st.runSync());
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return results;
  }
}

const SKIP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'expect']);

/**
 * @param {{allowedOrigins?: string[], postsPerMinute?: number}} [opts]
 * @returns {Promise<{url:string, db:FakeD1, env:object, close:()=>Promise<void>}>}
 */
export async function startMailboxServer({ allowedOrigins = [], postsPerMinute = 1000 } = {}) {
  const env = { DB: new FakeD1(), ALLOWED_ORIGINS: allowedOrigins.join(','), POSTS_PER_MINUTE: String(postsPerMinute), SYNC_WRITES_PER_MINUTE: '10000' };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (!SKIP_HEADERS.has(k) && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
      const response = await worker.fetch(request, env);
      const out = {};
      response.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, db: env.DB, env, close: () => new Promise((r) => server.close(r)) };
}
