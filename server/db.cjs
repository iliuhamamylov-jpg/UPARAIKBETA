const { DatabaseSync } = require("node:sqlite");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const file =
  process.env.AFISHA_DB || path.join(__dirname, "../storage/afisha.sqlite");
mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec(`
 PRAGMA foreign_keys=ON;
 PRAGMA journal_mode=WAL;
 PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS artists(id TEXT PRIMARY KEY,name TEXT NOT NULL,genre TEXT NOT NULL,image TEXT NOT NULL,baseline INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS venues(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL);
 CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,artist TEXT NOT NULL REFERENCES artists,venue INTEGER NOT NULL REFERENCES venues,date TEXT NOT NULL,time TEXT NOT NULL,base INTEGER NOT NULL CHECK(base>0),cancelled INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,phone TEXT DEFAULT '',salt TEXT NOT NULL,hash TEXT NOT NULL,role TEXT DEFAULT 'user');
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,owner INTEGER REFERENCES users,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS favorites(owner INTEGER REFERENCES users,event TEXT REFERENCES events,PRIMARY KEY(owner,event));
 CREATE TABLE IF NOT EXISTS bookings(id TEXT PRIMARY KEY,owner INTEGER REFERENCES users,event TEXT REFERENCES events,seats TEXT NOT NULL,total INTEGER NOT NULL,status TEXT DEFAULT 'active');
 CREATE TABLE IF NOT EXISTS occupied(event TEXT REFERENCES events,seat INTEGER CHECK(seat BETWEEN 0 AND 191),booking TEXT REFERENCES bookings,PRIMARY KEY(event,seat));
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY);
`);
const findRows = (sql, ...args) => db.prepare(sql).all(...args);
const findRow = (sql, ...args) => db.prepare(sql).get(...args);
const executeStatement = (sql, ...args) => db.prepare(sql).run(...args);
function inTransaction(operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function addEvent(id, artist, venue, date, time, price) {
  executeStatement("INSERT OR IGNORE INTO venues(name) VALUES(?)", venue);
  executeStatement(
    "INSERT INTO events(id,artist,venue,date,time,base) VALUES(?,?,(SELECT id FROM venues WHERE name=?),?,?,?)",
    id,
    artist,
    venue,
    date,
    time,
    price,
  );
}
if (!findRow("SELECT key FROM settings WHERE key='seed'"))
  inTransaction(() => {
    for (const {
      id,
      name,
      date,
      time,
      venue,
      price,
      genre,
      bookingCount,
    } of require("./seed.json")) {
      executeStatement(
        "INSERT INTO artists(id,name,genre,image,baseline) VALUES(?,?,?,?,?)",
        id,
        name,
        genre,
        id,
        bookingCount,
      );
      addEvent(id, id, venue, date, time, price);
    }
    executeStatement("INSERT INTO settings VALUES('seed')");
  });
const capacity = 192;
function calculateSeatPrice(base, sold, seat) {
  const rowPremium = (11 - Math.floor(seat / 16)) * 100;
  return Math.round(
    (base + rowPremium) * (1 + Math.floor((sold * 4) / capacity) / 10),
  );
}
function getSeatMap(id) {
  const event = findRow("SELECT base,cancelled FROM events WHERE id=?", id);
  if (!event || event.cancelled)
    throw Object.assign(Error("Концерт недоступен."), { status: 409 });
  const occupied = findRows("SELECT seat FROM occupied WHERE event=?", id).map(
    (row) => row.seat,
  );
  return {
    occupied,
    prices: Array.from({ length: capacity }, (_, seat) =>
      calculateSeatPrice(event.base, occupied.length, seat),
    ),
  };
}
function listConcerts() {
  return findRows(`SELECT e.id,a.id artist,a.name,a.genre,a.image,a.baseline+(SELECT count(*) FROM occupied o JOIN events x ON x.id=o.event WHERE x.artist=a.id) count,
 e.date,e.time,v.name venue,e.base,e.cancelled,(SELECT count(*) FROM occupied o WHERE o.event=e.id) sold
 FROM events e JOIN artists a ON e.artist=a.id JOIN venues v ON e.venue=v.id ORDER BY count DESC`).map(
    (concert) => ({
      ...concert,
      price: calculateSeatPrice(concert.base, concert.sold, 191),
    }),
  );
}
module.exports = {
  db,
  findRow,
  findRows,
  executeStatement,
  inTransaction,
  addEvent,
  getSeatMap,
  listConcerts,
};
