const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { once } = require("node:events");
test("Общее место, цена, роли, отмена и восстановление после перезапуска", async (t) => {
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
  const id = await add("2027-01-20"),
    other = await add("2027-01-21");
  assert.ok(id && other);
  const hall = async (event) => (await request("hall/" + event)).json;
  const initial = await hall(id);
  const entries = { id, seats: [0], total: initial.prices[0] };
  const race = await Promise.all([
    request("book", a, entries),
    request("book", b, entries),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const winner = race[0].status === 200 ? a : b,
    loser = winner === a ? b : a,
    key = race.find((r) => r.status === 200).json.key;
  assert.deepEqual((await hall(other)).occupied, []);
  assert.equal((await request("cancel", loser, { key })).status, 404);
  const seats = Array.from({ length: 47 }, (_, i) => i + 1);
  assert.equal(
    (
      await request("book", winner, {
        id,
        seats,
        total: seats.reduce((s, n) => s + initial.prices[n], 0),
      })
    ).status,
    200,
  );
  assert.ok((await hall(id)).prices[80] > initial.prices[80]);
  assert.equal(
    (
      await request("book", loser, {
        id,
        seats: [80],
        total: initial.prices[80],
      })
    ).status,
    409,
  );
  await stop();
  await start();
  assert.equal(
    (await request("account", winner)).json.tickets.find((t) => t.key === key)
      .total,
    entries.total,
  );
  assert.equal((await request("cancel", winner, { key })).status, 200);
  assert.ok(!(await hall(id)).occupied.includes(0));
  const group = (await request("account", winner)).json.tickets.find(
    (t) => t.seats.length > 1,
  );
  const [first, second] = group.admissions;
  assert.notEqual(first.code, second.code);
  assert.equal(
    (await request("admin/ticket-check", b, { code: first.code })).status,
    403,
  );
  assert.equal(
    (await request("admin/ticket-check", a, { code: first.code })).json.status,
    "valid",
  );
  assert.equal(
    (await request("admin/ticket-check", a, { code: "1111-1111-1111" })).status,
    404,
  );
  const image = await fetch(url + "/api/qr/" + first.code, {
    headers: { cookie: winner },
  });
  assert.equal(image.headers.get("content-type"), "image/svg+xml");
  assert.match(await image.text(), /<path d="M/);
  const activations = await Promise.all(
    [1, 2].map(() => request("admin/ticket-redeem", a, { code: first.code })),
  );
  assert.deepEqual(activations.map((r) => r.status).sort(), [200, 409]);
  await stop();
  await start();
  assert.equal(
    (await request("admin/ticket-check", a, { code: first.code })).json.status,
    "used",
  );
  assert.equal(
    (await request("admin/ticket-check", a, { code: second.code })).json.status,
    "valid",
  );
  assert.equal(
    (await request("cancel", winner, { key: group.key })).status,
    409,
  );
  await request("admin/remove-event", a, { id });
  assert.equal(
    (await request("admin/ticket-redeem", a, { code: second.code })).status,
    409,
  );
  assert.equal(
    (await request("catalog")).json.some((c) => c.id === id),
    false,
  );
  assert.ok(
    (await request("account", winner)).json.tickets.some(
      (t) => t.status === "event-cancelled",
    ),
  );
  assert.equal(
    (await request("admin/remove-artist", a, { id: artist })).status,
    409,
  );
  await request("admin/remove-event", a, { id: other });
  assert.equal(
    (await request("admin/remove-artist", a, { id: artist })).status,
    200,
  );
});
