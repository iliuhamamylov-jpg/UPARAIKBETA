const { randomBytes } = require("node:crypto");
const {
  db,
  findRow,
  findRows,
  executeStatement,
  inTransaction,
} = require("./db.cjs");
const QRCode = require("./vendor/QRCode");
const labels = {
  listed: "Выставлен на продажу",
  valid: "Действителен",
  used: "Использован",
  cancelled: "Бронь отменена",
  "event-cancelled": "Концерт отменён",
  expired: "Дата концерта прошла",
};
function issueTickets(booking, seats, priceForSeat = () => null) {
  for (const seat of seats) {
    const code = randomBytes(6)
      .toString("hex")
      .toUpperCase()
      .match(/.{4}/g)
      .join("-");
    executeStatement(
      "INSERT INTO admissions(code,booking,seat,faceValue) VALUES(?,?,?,?)",
      code,
      booking,
      seat,
      priceForSeat(seat),
    );
  }
}
inTransaction(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS admissions(
 code TEXT PRIMARY KEY,booking TEXT NOT NULL REFERENCES bookings,seat INTEGER NOT NULL,
 usedAt TEXT,usedBy INTEGER REFERENCES users,UNIQUE(booking,seat))`);
  if (
    !findRows("PRAGMA table_info(admissions)").some(
      (column) => column.name === "faceValue",
    )
  )
    db.exec("ALTER TABLE admissions ADD COLUMN faceValue INTEGER");
  db.exec(
    "CREATE TABLE IF NOT EXISTS resale(id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL REFERENCES admissions(code) ON DELETE CASCADE)",
  );
  for (const booking of findRows(
    "SELECT id,seats FROM bookings WHERE NOT EXISTS(SELECT 1 FROM admissions WHERE booking=bookings.id)",
  )) {
    issueTickets(booking.id, JSON.parse(booking.seats));
  }
  // Older bookings stored only a total. Allocate each ruble to one seat.
  for (const booking of findRows(
    "SELECT DISTINCT b.id,b.total,b.seats FROM bookings b JOIN admissions a ON a.booking=b.id WHERE a.faceValue IS NULL",
  )) {
    const seats = JSON.parse(booking.seats);
    seats.forEach((seat, index) =>
      executeStatement(
        "UPDATE admissions SET faceValue=? WHERE booking=? AND seat=? AND faceValue IS NULL",
        Math.floor(booking.total / seats.length) +
          Number(index < booking.total % seats.length),
        booking.id,
        seat,
      ),
    );
  }
});
function normalizeTicketCode(value) {
  const raw =
    typeof value === "string"
      ? value.trim().toUpperCase().replace(/[\s-]/g, "")
      : "";
  if (!/^[A-F0-9]{12}$/.test(raw))
    throw Object.assign(Error("Введите 12 знаков номера билета."), {
      status: 400,
    });
  return raw.match(/.{4}/g).join("-");
}
const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function inspectTicket(input) {
  const ticket = findRow(
    `SELECT t.code,t.seat,t.usedAt,b.status,e.cancelled,e.date,e.time,a.name,v.name venue
 FROM admissions t JOIN bookings b ON b.id=t.booking JOIN events e ON e.id=b.event
 JOIN artists a ON a.id=e.artist JOIN venues v ON v.id=e.venue WHERE t.code=?`,
    normalizeTicketCode(input),
  );
  if (!ticket)
    throw Object.assign(Error("Билет с таким номером не найден."), {
      status: 404,
    });
  let status = ticket.status;
  if (ticket.usedAt) status = "used";
  else if (ticket.cancelled) status = "event-cancelled";
  else if (status === "active")
    status = ticket.date < today.format(new Date()) ? "expired" : "valid";
  if (
    status === "valid" &&
    findRow("SELECT 1 FROM resale WHERE code=?", ticket.code)
  )
    status = "listed";
  return { ...ticket, status, label: labels[status] };
}
function redeemTicket(code, admin) {
  return inTransaction(() => {
    const ticket = inspectTicket(code);
    if (ticket.status !== "valid")
      throw Object.assign(Error(ticket.label + ". Проход не разрешён."), {
        status: 409,
      });
    executeStatement(
      "UPDATE admissions SET usedAt=?,usedBy=? WHERE code=? AND usedAt IS NULL",
      new Date().toISOString(),
      admin,
      ticket.code,
    );
    return inspectTicket(ticket.code);
  });
}
function renderTicketQr(code, owner) {
  const ticket = findRow(
    "SELECT code FROM admissions JOIN bookings ON bookings.id=admissions.booking WHERE code=? AND bookings.owner=?",
    normalizeTicketCode(code),
    owner,
  );
  if (!ticket) throw Object.assign(Error("Билет не найден."), { status: 404 });
  const matrix = new QRCode(1, 0);
  matrix.addData(ticket.code);
  matrix.make();
  const dots = matrix.modules
    .flatMap((row, y) =>
      row.map((on, x) =>
        on ? "M" + (x + 4) + " " + (y + 4) + "h1v1h-1z" : "",
      ),
    )
    .join("");
  const size = matrix.getModuleCount() + 8;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    size +
    " " +
    size +
    '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="' +
    dots +
    '"/></svg>'
  );
}
module.exports = {
  normalizeTicketCode,
  todayInMoscow: () => today.format(new Date()),
  issueTickets,
  inspectTicket,
  redeemTicket,
  renderTicketQr,
};
