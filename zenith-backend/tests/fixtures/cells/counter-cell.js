// A portable cell: no imports, only `ctx` and `env`. The same file runs on Zenith's local provider
// and, bundled by `celld deploy`/`celld dev`, on celld (tests/unit/cells-celld.test.ts).
export class Counter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (n INTEGER)");
  }
  async increment(by = 1) {
    const n = ((await this.ctx.storage.get("n")) ?? 0) + by;
    await this.ctx.storage.put("n", n);
    this.ctx.storage.sql.exec("INSERT INTO hits VALUES (?)", n);
    return n;
  }
  async value() {
    return {
      n: (await this.ctx.storage.get("n")) ?? 0,
      hits: this.ctx.storage.sql.exec("SELECT count(*) AS c FROM hits").one().c,
      fired: (await this.ctx.storage.get("fired")) ?? 0,
      name: this.ctx.id.name ?? null,
    };
  }
  async arm(ms) {
    await this.ctx.storage.setAlarm(Date.now() + ms);
    return true;
  }
  async alarm() {
    await this.ctx.storage.put("fired", ((await this.ctx.storage.get("fired")) ?? 0) + 1);
  }
  fail() {
    throw new RangeError("on purpose");
  }
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.text() : null;
    return Response.json({ path: url.pathname, q: url.searchParams.get("q"), body });
  }
}
