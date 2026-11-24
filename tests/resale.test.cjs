const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { once } = require("node:events");
test("Перепродажа отдельного места и отзыв старого QR", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "afisha-test-"));
  const env = {
    ...process.env,
    AFISHA_DB: path.join(tmp, "test.sqlite"),
    PORT: "0",
  };
  const root = path.join(__dirname, "..");
  let proc, url;
  async function start() {
    proc = spawn(process.execPath, ["server/index.cjs"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const [msg] = await Promise.race([
      once(proc.stdout, "data"),
      once(proc, "exit").then(() => {
        throw Error("Сервер завершился");
      }),
    ]);
    url = String(msg).trim().split(" ").pop().replace("localhost", "127.0.0.1");
  }
  async function stop() {
    if (proc && proc.exitCode === null) {
      const done = once(proc, "exit");
      proc.kill();
      await done;
    }
  }
  t.after(async () => {
    await stop();
    rmSync(tmp, { recursive: true, force: true });
  });
  const request = async (route, cookie = "", data) => {
    const r = await fetch(url + "/api/" + route, {
      method: data ? "POST" : "GET",
      headers: { cookie, "Content-Type": "application/json" },
      body: data ? JSON.stringify(data) : undefined,
    });
    return {
      status: r.status,
      json: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  };
  await start();
  const register = async (name) =>
    (
      await request("register", "", {
        name,
        email: name + "@example.org",
        password: "test-password",
      })
    ).cookie;
  const a = await register("Ada"),
    b = await register("Max");
  assert.ok(a && b);
  assert.equal((await request("admin", b)).status, 403);
  const grant = spawnSync(
    process.execPath,
    ["server/grant-admin.cjs", "Ada@example.org"],
    { cwd: root, env },
  );
  assert.equal(grant.status, 0);
  const artist = (
    await request("admin/artist", a, { name: "Тест", genre: "Рок" })
  ).json.id;
  const add = async (date) =>
    (
      await request("admin/event", a, {
        artist,
        date,
        time: "20:00",
        venue: "Тестовый зал",
        price: 2000,
      })
    ).json.id;
  const id = await add("2099-01-20");
  const prices = (await request("hall/" + id)).json.prices;
  const seats = [0, 64];
  assert.equal(
    (await request("book", a, { id, seats, total: prices[0] + prices[64] }))
      .status,
    200,
  );
  const account = async (cookie) =>
    (await request("account", cookie)).json.tickets;
  const [group] = await account(a);
  const [ticket, keep] = group.admissions;
  const list = async () =>
    (await request("resale/list", a, { code: ticket.code })).json.id;
  assert.equal(
    (await request("resale/list", b, { code: ticket.code })).status,
    404,
  );
  let offer = await list();
  assert.ok(offer);
  assert.equal(
    (await request("admin/ticket-redeem", a, { code: ticket.code })).status,
    409,
  );
  assert.equal(
    (await request("resale/withdraw", a, { id: offer })).status,
    200,
  );
  assert.equal(
    (await request("admin/ticket-check", a, { code: ticket.code })).json.status,
    "valid",
  );
  offer = await list();
  const publicListings = (await request("resale")).json;
  assert.equal(publicListings[0].price, prices[0]);
  assert.ok(!JSON.stringify(publicListings).includes(ticket.code));
  assert.equal((await request("resale/buy", a, { id: offer })).status, 409);
  const c = await register("Third");
  const race = await Promise.all(
    [b, c].map((cookie) => request("resale/buy", cookie, { id: offer })),
  );
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const buyer = race[0].status === 200 ? b : c;
  const [sold] = await account(buyer);
  assert.notEqual(sold.admissions[0].code, ticket.code);
  assert.deepEqual((await account(a))[0].seats, [64]);
  assert.equal((await account(a))[0].total, prices[64]);
  assert.equal(
    (await request("admin/ticket-check", a, { code: ticket.code })).status,
    404,
  );
  assert.equal(
    (await request("admin/ticket-redeem", a, { code: sold.admissions[0].code }))
      .json.status,
    "used",
  );
  assert.ok((await request("hall/" + id)).json.occupied.includes(0));
  const final = (await request("resale/list", a, { code: keep.code })).json.id;
  assert.equal((await request("resale/buy", buyer, { id: final })).status, 200);
  assert.equal((await account(a)).length, 0);
});
