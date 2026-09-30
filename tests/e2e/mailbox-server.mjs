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
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes) } };
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
  async batch(statements) {
    const results = [];
    for (const st of statements) results.push(await st.run());
    return results;
  }
}

const SKIP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'expect']);

/**
 * @param {{allowedOrigins?: string[], postsPerMinute?: number}} [opts]
 * @returns {Promise<{url:string, db:FakeD1, env:object, close:()=>Promise<void>}>}
 */
export async function startMailboxServer({ allowedOrigins = [], postsPerMinute = 1000 } = {}) {
  const env = { DB: new FakeD1(), ALLOWED_ORIGINS: allowedOrigins.join(','), POSTS_PER_MINUTE: String(postsPerMinute) };
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
