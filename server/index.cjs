const http = require("node:http");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  findRows,
  findRow,
  executeStatement,
  inTransaction,
  getSeatMap,
  listConcerts,
  addEvent,
} = require("./db.cjs");
const resale = require("./resale.cjs");
const tickets = require("./tickets.cjs");
const derivePasswordHash = promisify(crypto.scrypt);
const root = path.join(__dirname, "..");
const port = Number(process.env.PORT || 8080);
const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
const digest = (s) => crypto.createHash("sha256").update(s).digest("hex");
const createId = () => crypto.randomUUID();
function readText(value, min = 1, max = 100) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  )
    fail(400, "Проверьте поля формы.");
  return value.trim();
}
function normalizeEmail(value) {
  const address = readText(value, 3, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
    fail(400, "Проверьте адрес электронной почты.");
  return address;
}
async function readJsonBody(request) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    fail(415, "Ожидается JSON.");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16384) fail(413, "Слишком большой запрос.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value;
  } catch {}
  fail(400, "Неверный формат данных.");
}
function createSession(response, id) {
  const token = crypto.randomBytes(32).toString("hex");
  executeStatement("DELETE FROM sessions WHERE expires<?", Date.now());
  executeStatement(
    "INSERT INTO sessions VALUES(?,?,?)",
    digest(token),
    id,
    Date.now() + 7 * 86400000,
  );
  response.setHeader(
    "Set-Cookie",
    "afisha=" + token + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800",
  );
}
function getAccountState(user) {
  if (!user) return { profile: null, tickets: [], favorites: [] };
  const tickets = findRows(
    "SELECT id AS key,event AS id,seats,total,status FROM bookings WHERE owner=? ORDER BY rowid DESC",
    user.id,
  );
  return {
    profile: user,
    tickets: tickets.map((booking) => ({
      ...booking,
      seats: JSON.parse(booking.seats),
      admissions: findRows(
        "SELECT a.code,a.seat,a.usedAt,a.faceValue,r.id AS offer FROM admissions a LEFT JOIN resale r ON r.code=a.code WHERE a.booking=? ORDER BY a.seat",
        booking.key,
      ),
    })),
    favorites: findRows(
      "SELECT event FROM favorites WHERE owner=?",
      user.id,
    ).map((favorite) => favorite.event),
  };
}
const loginAttempts = new Map();
async function authenticateUser(route, payload, response, ip) {
  const now = Date.now();
  for (const [addressKey, attemptWindow] of loginAttempts)
    if (attemptWindow.until < now) loginAttempts.delete(addressKey);
  let attempts = loginAttempts.get(ip) || { count: 0, until: now + 60000 };
  loginAttempts.set(ip, attempts);
  if (++attempts.count > 30)
    fail(429, "Слишком много попыток. Повторите через минуту.");
  const address = normalizeEmail(payload.email);
  if (
    typeof payload.password !== "string" ||
    payload.password.length < 8 ||
    payload.password.length > 256
  )
    fail(400, "Длина пароля — от 8 до 256 символов.");
  if (route === "register") {
    const name = readText(payload.name),
      salt = crypto.randomBytes(16).toString("hex"),
      hash = (await derivePasswordHash(payload.password, salt, 64)).toString(
        "hex",
      );
    if (findRow("SELECT id FROM users WHERE email=?", address))
      fail(409, "Адрес уже зарегистрирован.");
    const result = executeStatement(
      "INSERT INTO users(email,name,salt,hash) VALUES(?,?,?,?)",
      address,
      name,
      salt,
      hash,
    );
    createSession(response, Number(result.lastInsertRowid));
  } else {
    const user = findRow("SELECT * FROM users WHERE email=?", address);
    const value = await derivePasswordHash(
      payload.password,
      user?.salt || "absent-account",
      64,
    );
    if (!user || !crypto.timingSafeEqual(value, Buffer.from(user.hash, "hex")))
      fail(401, "Неверный email или пароль.");
    createSession(response, user.id);
  }
  return { ok: true };
}
function reserveSeats(user, payload) {
  if (
    !Array.isArray(payload.seats) ||
    !payload.seats.length ||
    payload.seats.length > 192 ||
    payload.seats.some(
      (seatIndex) =>
        !Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= 192,
    ) ||
    new Set(payload.seats).size !== payload.seats.length
  )
    fail(400, "Проверьте выбранные места.");
  return inTransaction(() => {
    const id = readText(payload.id),
      map = getSeatMap(id);
    if (payload.seats.some((seatIndex) => map.occupied.includes(seatIndex)))
      fail(409, "Одно из мест уже занято. Выберите места снова.");
    const total = payload.seats.reduce(
      (sum, seatIndex) => sum + map.prices[seatIndex],
      0,
    );
    if (total !== payload.total)
      fail(409, "Стоимость изменилась. Подтвердите новую цену.");
    const key = createId();
    executeStatement(
      "INSERT INTO bookings(id,owner,event,seats,total) VALUES(?,?,?,?,?)",
      key,
      user.id,
      id,
      JSON.stringify(payload.seats),
      total,
    );
    tickets.issueTickets(key, payload.seats, (seat) => map.prices[seat]);
    for (const seatIndex of payload.seats)
      executeStatement(
        "INSERT INTO occupied VALUES(?,?,?)",
        id,
        seatIndex,
        key,
      );
    return { key, total };
  });
}
function handleAdminRequest(route, payload, user) {
  if (route === "ticket-check") return tickets.inspectTicket(payload.code);
  if (route === "ticket-redeem")
    return tickets.redeemTicket(payload.code, user.id);
  if (route === "artist") {
    const id = createId();
    executeStatement(
      "INSERT INTO artists(id,name,genre,image) VALUES(?,?,?,'crowd')",
      id,
      readText(payload.name),
      readText(payload.genre),
    );
    return { id };
  }
  if (route === "remove-artist") {
    const id = readText(payload.id);
    if (findRow("SELECT id FROM events WHERE artist=? AND cancelled=0", id))
      fail(409, "Сначала отмените концерты артиста.");
    executeStatement("UPDATE artists SET hidden=1 WHERE id=?", id);
    return { ok: true };
  }
  if (route === "event" || route === "edit-event") {
    const artist = readText(payload.artist),
      date = readText(payload.date),
      time = readText(payload.time);
    if (!findRow("SELECT id FROM artists WHERE id=? AND hidden=0", artist))
      fail(400, "Выберите артиста.");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
      !Number.isInteger(payload.price) ||
      payload.price < 1 ||
      payload.price > 1000000
    )
      fail(400, "Проверьте дату, время и цену.");
    const venue = readText(payload.venue);
    const id = route === "event" ? createId() : readText(payload.id);
    inTransaction(() => {
      if (route === "event") {
        addEvent(id, artist, venue, date, time, payload.price);
        return;
      }
      const event = findRow(
        "SELECT artist,cancelled FROM events WHERE id=?",
        id,
      );
      if (!event || event.cancelled)
        fail(409, "Концерт недоступен для редактирования.");
      if (
        event.artist !== artist &&
        findRow("SELECT id FROM bookings WHERE event=? LIMIT 1", id)
      )
        fail(409, "У концерта есть билеты. Сменить артиста нельзя.");
      executeStatement("INSERT OR IGNORE INTO venues(name) VALUES(?)", venue);
      executeStatement(
        "UPDATE events SET artist=?, venue=(SELECT id FROM venues WHERE name=?), date=?, time=?, base=? WHERE id=?",
        artist,
        venue,
        date,
        time,
        payload.price,
        id,
      );
    });
    return { id };
  }
  if (route === "remove-event")
    return inTransaction(() => {
      const id = readText(payload.id);
      executeStatement("UPDATE events SET cancelled=1 WHERE id=?", id);
      executeStatement(
        "UPDATE bookings SET status='event-cancelled' WHERE event=? AND status='active'",
        id,
      );
      executeStatement("DELETE FROM occupied WHERE event=?", id);
      executeStatement("DELETE FROM favorites WHERE event=?", id);
      return { ok: true };
    });
  fail(404, "Страница не найдена.");
}
async function handleApiRequest(request, response, route) {
  const token = digest(
    /(?:^|;\s*)afisha=([a-f0-9]{64})/.exec(request.headers.cookie || "")?.[1] ||
      "",
  );
  const user = findRow(
    "SELECT u.id,u.email,u.name,u.phone,u.role FROM users u JOIN sessions s ON s.owner=u.id WHERE s.token=? AND s.expires>?",
    token,
    Date.now(),
  );
  if (request.method === "GET") {
    if (route.startsWith("qr/")) {
      if (!user) fail(401, "Войдите в аккаунт.");
      return tickets.renderTicketQr(route.slice(3), user.id);
    }
    if (route === "resale") return resale.listOffers(user?.id);
    if (route === "catalog") return listConcerts().filter((c) => !c.cancelled);
    if (route === "account")
      return {
        ...getAccountState(user),
        archived: user
          ? listConcerts().filter(
              (c) =>
                c.cancelled &&
                findRow(
                  "SELECT id FROM bookings WHERE event=? AND owner=?",
                  c.id,
                  user.id,
                ),
            )
          : [],
      };
    if (route.startsWith("hall/")) return getSeatMap(route.slice(5));
    if (route === "admin/dashboard" && user?.role === "admin") {
      return {
        operator: user.name,
        artists: findRows(
          "SELECT id,name,genre,image FROM artists WHERE hidden=0 ORDER BY name",
        ),
        events: listConcerts(),
        users: findRows("SELECT name, role FROM users ORDER BY name"),
        checkedIn: findRow(
          "SELECT COUNT(*) AS total FROM admissions WHERE usedAt IS NOT NULL",
        ).total,
      };
    }
    if (route === "admin" && user?.role === "admin")
      return {
        artists: findRows(
          "SELECT id,name,genre FROM artists WHERE hidden=0 ORDER BY name",
        ),
        events: listConcerts().filter((c) => !c.cancelled),
      };
    fail(403, "Нет доступа.");
  }
  if (request.method !== "POST") fail(405, "Метод недоступен.");
  if (
    request.headers.origin &&
    new URL(request.headers.origin).host !== request.headers.host
  )
    fail(403, "Нет доступа.");
  const payload = await readJsonBody(request);
  if (["register", "login"].includes(route))
    return authenticateUser(
      route,
      payload,
      response,
      request.socket.remoteAddress,
    );
  if (!user) fail(401, "Войдите в аккаунт.");
  if (["resale/list", "resale/withdraw", "resale/buy"].includes(route)) {
    if (route !== "resale/list") readText(payload.id);
    return resale.changeOffer(route.slice(7), user, payload);
  }
  if (route.startsWith("admin/")) {
    if (user.role !== "admin") fail(403, "Нет доступа.");
    return handleAdminRequest(route.slice(6), payload, user);
  }
  if (route === "logout") {
    executeStatement("DELETE FROM sessions WHERE token=?", token);
    response.setHeader(
      "Set-Cookie",
      "afisha=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    );
  } else if (route === "profile") {
    const address = normalizeEmail(payload.email);
    if (
      findRow("SELECT id FROM users WHERE email=? AND id<>?", address, user.id)
    )
      fail(409, "Email занят.");
    executeStatement(
      "UPDATE users SET name=?,email=?,phone=? WHERE id=?",
      readText(payload.name),
      address,
      readText(payload.phone, 0, 40),
      user.id,
    );
  } else if (route === "favorite") {
    if (
      !findRow(
        "SELECT id FROM events WHERE id=? AND cancelled=0",
        readText(payload.id),
      )
    )
      fail(404, "Концерт недоступен.");
    if (payload.enabled === true)
      executeStatement(
        "INSERT OR IGNORE INTO favorites VALUES(?,?)",
        user.id,
        payload.id,
      );
    else
      executeStatement(
        "DELETE FROM favorites WHERE owner=? AND event=?",
        user.id,
        payload.id,
      );
  } else if (route === "book") return reserveSeats(user, payload);
  else if (route === "cancel")
    inTransaction(() => {
      const key = readText(payload.key);
      if (
        !findRow(
          "SELECT id FROM bookings WHERE id=? AND owner=? AND status='active'",
          key,
          user.id,
        )
      )
        fail(404, "Активная бронь не найдена.");
      if (
        findRow(
          "SELECT code FROM admissions WHERE booking=? AND usedAt IS NOT NULL",
          key,
        )
      )
        fail(409, "Вход уже отмечен. Отменить эту бронь целиком нельзя.");
      executeStatement(
        "UPDATE bookings SET status='cancelled' WHERE id=?",
        key,
      );
      executeStatement("DELETE FROM occupied WHERE booking=?", key);
    });
  else fail(404, "Страница не найдена.");
  return { ok: true };
}
const types = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  jpg: "image/jpeg",
};
const pages = new Set([
  "index.html",
  "concerts.html",
  "profile.html",
  "admin.html",
  "admin.js",
  "pages.js",
  "scanner.js",
  "jsQR.js",
  "data.js",
  "app.js",
  "style.css",
  "portal.css",
]);
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost"),
      file = url.pathname.slice(1) || "index.html";
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (file.startsWith("api/")) {
      const result = await handleApiRequest(request, response, file.slice(4));
      if (typeof result === "string" && file.startsWith("api/qr/")) {
        response.setHeader("Content-Type", "image/svg+xml");
        response.end(result);
        return;
      }
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(result));
      return;
    }
    if (!pages.has(file) && !/^assets\/[a-z0-9_-]+\.jpg$/.test(file))
      fail(404, "Файл не найден.");
    const bytes = await fs.readFile(path.join(root, file));
    response.setHeader("Content-Type", types[file.split(".").pop()]);
    if (file.endsWith(".html") && file !== "admin.html") {
      const templates = await fs.readFile(
        path.join(root, "templates.html"),
        "utf8",
      );
      response.end(
        bytes
          .toString("utf8")
          .replace("<!-- shared-templates -->", () => templates),
      );
    } else response.end(bytes);
  } catch (error) {
    const status = error.status || (error.code === "ENOENT" ? 404 : 500);
    if (status === 500) console.error(error);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify({
        error: status === 500 ? "Ошибка сервера." : error.message,
      }),
    );
  }
});
if (process.env.AFISHA_LAN_IP) {
  const tls = require("node:https").createServer(
    {
      pfx: require("node:fs").readFileSync(
        path.join(root, "storage", "lan.pfx"),
      ),
    },
    server.listeners("request")[0],
  );
  tls.listen(8443, process.env.AFISHA_LAN_IP, () =>
    console.log(
      "HTTPS: https://" + process.env.AFISHA_LAN_IP + ":8443/admin.html",
    ),
  );
}
server.listen(port, "127.0.0.1", () =>
  console.log("Афиша: http://localhost:" + server.address().port),
);
