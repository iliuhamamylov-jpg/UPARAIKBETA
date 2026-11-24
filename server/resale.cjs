const { randomUUID } = require("node:crypto");
const {
  findRow,
  findRows,
  executeStatement,
  inTransaction,
} = require("./db.cjs");
const tickets = require("./tickets.cjs");
function reject(status, message) {
  throw Object.assign(Error(message), { status });
}
function listOffers(viewer) {
  return findRows(
    `SELECT r.id,b.event,a.seat,a.faceValue AS price,b.owner=? AS mine
    FROM resale r JOIN admissions a ON a.code=r.code JOIN bookings b ON b.id=a.booking
    JOIN events e ON e.id=b.event WHERE b.status='active' AND e.cancelled=0
    AND a.usedAt IS NULL AND e.date>=? ORDER BY r.rowid DESC`,
    viewer ?? "",
    tickets.todayInMoscow(),
  );
}
function changeOffer(action, user, payload) {
  return inTransaction(() => {
    if (action === "list") {
      const code = tickets.normalizeTicketCode(payload.code);
      if (
        !findRow(
          "SELECT 1 FROM admissions a JOIN bookings b ON b.id=a.booking WHERE a.code=? AND b.owner=?",
          code,
          user.id,
        )
      )
        reject(404, "Билет не найден.");
      if (tickets.inspectTicket(code).status !== "valid")
        reject(409, "Этот билет нельзя выставить.");
      const id = randomUUID();
      executeStatement("INSERT INTO resale(id,code) VALUES(?,?)", id, code);
      return { id };
    }
    const offer = findRow(
      `SELECT r.code,a.seat,a.faceValue,b.* FROM resale r JOIN admissions a ON a.code=r.code JOIN bookings b ON b.id=a.booking WHERE r.id=?`,
      payload.id,
    );
    if (!offer) reject(409, "Предложение уже недоступно.");
    if (action === "withdraw") {
      if (offer.owner !== user.id) reject(403, "Нет доступа.");
      executeStatement("DELETE FROM resale WHERE id=?", payload.id);
      return { ok: true };
    }
    if (offer.owner === user.id) reject(409, "Это ваш билет.");
    if (tickets.inspectTicket(offer.code).status !== "listed")
      reject(409, "Билет недоступен.");
    const newBooking = randomUUID();
    executeStatement(
      "INSERT INTO bookings(id,owner,event,seats,total) VALUES(?,?,?,?,?)",
      newBooking,
      user.id,
      offer.event,
      JSON.stringify([offer.seat]),
      offer.faceValue,
    );
    tickets.issueTickets(newBooking, [offer.seat], () => offer.faceValue);
    const moved = executeStatement(
      "UPDATE occupied SET booking=? WHERE booking=? AND event=? AND seat=?",
      newBooking,
      offer.id,
      offer.event,
      offer.seat,
    );
    if (moved.changes !== 1) reject(409, "Место недоступно.");
    executeStatement("DELETE FROM admissions WHERE code=?", offer.code);
    const remaining = JSON.parse(offer.seats).filter(
      (seat) => seat !== offer.seat,
    );
    if (remaining.length)
      executeStatement(
        "UPDATE bookings SET seats=?,total=total-? WHERE id=?",
        JSON.stringify(remaining),
        offer.faceValue,
        offer.id,
      );
    else executeStatement("DELETE FROM bookings WHERE id=?", offer.id);
    return { key: newBooking };
  });
}
module.exports = { listOffers, changeOffer };
