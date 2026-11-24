const select = (selector, root = document) => root.querySelector(selector);
function cloneTemplate(id) {
  return document.getElementById(id).content.firstElementChild.cloneNode(true);
}
function setText(root, selector, value) {
  select(selector, root).textContent = value;
}
const formatPrice = (amount) => amount.toLocaleString("ru-RU") + " ₽";
const formatDate = (concert) =>
  concert.date
    .toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    })
    .replace(" г.", "");
const formatSeat = (index) =>
  "Ряд " + (1 + Math.floor(index / 16)) + ", место " + (1 + (index % 16));
function parseConcert(record) {
  return { ...record, date: new Date(record.date + "T12:00:00") };
}
async function requestApi(route, payload) {
  const options =
    payload === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        };
  const response = await fetch("/api/" + route, options);
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(result.error || "Не удалось выполнить запрос."),
      { status: response.status },
    );
  return result;
}
class Account {
  async refresh() {
    const state = await requestApi("account");
    this.profile = state.profile;
    this.tickets = state.tickets;
    this.favorites = state.favorites;
    this.archive = state.archived.map(parseConcert);
  }
  async update(route, payload) {
    await requestApi(route, payload);
    await this.refresh();
  }
}
const account = new Account();
let concerts = [];
function findConcert(id) {
  return (
    concerts.find((concert) => concert.id === id) ||
    account.archive.find((concert) => concert.id === id)
  );
}
function setPhoto(element, concert) {
  element.src = "assets/" + concert.image + ".jpg";
}
