const workspace = select("#workspace");
const loginForm = select("#admin-login");
const notice = select("#notice");
const verdict = select("#verdict");
const editor = select("#editor");
const eventForm = select("#event-form");
const artistForm = select("#artist-form");
const filters = select("#event-filters");
const pageLimit = select("#page-limit");
let dashboard;
let currentPage = 1;
let lookupGeneration = 0;

function showView() {
  const requested = location.hash.slice(1);
  const view = ["events", "artists", "check", "stats", "users"].includes(
    requested,
  )
    ? requested
    : "events";
  for (const section of workspace.querySelectorAll("[data-view]"))
    section.hidden = section.id !== view;
  workspace.classList.toggle("gate-view", view === "check");
  for (const link of document.querySelectorAll("#admin-nav a")) {
    if (link.hash === "#" + view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  stopCamera();
}
window.addEventListener("hashchange", showView);

function fillSelect(input, options, placeholder) {
  const previous = input.value;
  input.replaceChildren(
    ...(placeholder ? [new Option(placeholder, "")] : []),
    ...options,
  );
  if ([...input.options].some((option) => option.value === previous))
    input.value = previous;
}
function displayDate(value) {
  return new Date(value + "T12:00:00")
    .toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    })
    .replace(" г.", "");
}

function createEventRow(concert) {
  const row = cloneTemplate("event-item");
  row.dataset.id = concert.id;
  setPhoto(select("img", row), concert);
  setText(row, ".event-name span", concert.name);
  setText(row, "[data-date]", displayDate(concert.date) + "\n" + concert.time);
  setText(row, "[data-venue]", concert.venue);
  setText(row, ".state-chip", concert.cancelled ? "Отменён" : "Опубликован");
  row.classList.toggle("is-cancelled", Boolean(concert.cancelled));
  select("[data-edit-event]", row).disabled = Boolean(concert.cancelled);
  select("[data-remove-event]", row).disabled = Boolean(concert.cancelled);
  return row;
}
function renderEvents() {
  const { query, date, venue, status } = filters.elements;
  const search = query.value.trim().toLocaleLowerCase("ru");
  const matches = dashboard.events.filter(
    (concert) =>
      (concert.name + " " + concert.venue)
        .toLocaleLowerCase("ru")
        .includes(search) &&
      (!date.value || concert.date === date.value) &&
      (!venue.value || concert.venue === venue.value) &&
      (!status.value ||
        status.value === (concert.cancelled ? "cancelled" : "active")),
  );
  const size = Number(pageLimit.value);
  const count = Math.ceil(matches.length / size);
  currentPage = Math.min(currentPage, count) || 1;
  const offset = (currentPage - 1) * size;
  select("#admin-events").replaceChildren(
    ...matches.slice(offset, offset + size).map(createEventRow),
  );
  select("#no-events").hidden = Boolean(matches.length);
  select("#admin-pagination").replaceChildren(
    ...Array.from({ length: count }, (_, index) => {
      const button = cloneTemplate("page-button");
      button.textContent = index + 1;
      button.dataset.page = index + 1;
      button.setAttribute("aria-label", "Страница " + (index + 1));
      if (index + 1 === currentPage)
        button.setAttribute("aria-current", "page");
      return button;
    }),
  );
}
async function loadPanel() {
  dashboard = await requestApi("admin/dashboard");
  dashboard.events.sort((left, right) =>
    (left.date + left.time).localeCompare(right.date + right.time),
  );
  setText(document, "#operator", dashboard.operator);
  fillSelect(
    eventForm.elements.artist,
    dashboard.artists.map((artist) => new Option(artist.name, artist.id)),
  );
  const dates = [...new Set(dashboard.events.map((concert) => concert.date))];
  fillSelect(
    filters.elements.date,
    dates.map((date) => new Option(displayDate(date), date)),
    "Все даты",
  );
  const venues = [
    ...new Set(dashboard.events.map((concert) => concert.venue)),
  ].sort();
  fillSelect(
    filters.elements.venue,
    venues.map((venue) => new Option(venue, venue)),
    "Все площадки",
  );
  renderEvents();
  select("#admin-artists").replaceChildren(
    ...dashboard.artists.map((artist) => {
      const row = cloneTemplate("artist-item");
      setPhoto(select("img", row), artist);
      setText(row, "h2", artist.name);
      setText(row, "p", artist.genre);
      select("button", row).dataset.removeArtist = artist.id;
      return row;
    }),
  );
  select("#no-artists").hidden = Boolean(dashboard.artists.length);
  select("#admin-users").replaceChildren(
    ...dashboard.users.map((user) => {
      const row = cloneTemplate("user-item");
      setText(row, "strong", user.name);
      setText(row, "span", user.role === "admin" ? "Администратор" : "Зритель");
      return row;
    }),
  );
  const active = dashboard.events.filter((concert) => !concert.cancelled);
  const metrics = {
    active: active.length,
    cancelled: dashboard.events.length - active.length,
    sold: active.reduce((sum, concert) => sum + concert.sold, 0),
    users: dashboard.users.length,
    used: dashboard.checkedIn,
  };
  for (const label of workspace.querySelectorAll("[data-metric]"))
    label.textContent = metrics[label.dataset.metric].toLocaleString("ru-RU");
  loginForm.hidden = true;
  workspace.hidden = false;
  select("#admin-nav").hidden = false;
  select("#admin-logout").hidden = false;
  showView();
}
filters.onsubmit = (event) => event.preventDefault();
filters.oninput = pageLimit.onchange = () => {
  currentPage = 1;
  renderEvents();
};
select("#admin-pagination").onclick = (event) => {
  const button = event.target.closest("[data-page]");
  if (button) {
    currentPage = Number(button.dataset.page);
    renderEvents();
    select('[aria-current="page"]', event.currentTarget)?.focus();
  }
};
function openEditor(type, concert, copy = false) {
  eventForm.reset();
  artistForm.reset();
  eventForm.hidden = type !== "event";
  artistForm.hidden = type !== "artist";
  eventForm.dataset.id = concert && !copy ? concert.id : "";
  if (concert) {
    for (const key of ["artist", "date", "time", "venue"])
      eventForm.elements[key].value = concert[key];
    eventForm.elements.price.value = concert.base;
  }
  setText(
    editor,
    "h2",
    type === "artist"
      ? "Новый артист"
      : copy
        ? "Копия концерта"
        : concert
          ? "Редактировать концерт"
          : "Новый концерт",
  );
  setText(editor, "#editor-error", "");
  editor.showModal();
}
async function submitEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter || select("button", form);
  const payload = Object.fromEntries(new FormData(form));
  const id = form.dataset.id;
  let route = "artist";
  if (form === eventForm) {
    payload.price = Number(payload.price);
    if (id) payload.id = id;
    route = id ? "edit-event" : "event";
  }
  button.disabled = true;
  try {
    await requestApi("admin/" + route, payload);
    editor.close();
    await loadPanel();
    notice.textContent = "Изменения сохранены.";
  } catch (error) {
    (editor.open ? select("#editor-error") : notice).textContent =
      error.message;
  } finally {
    button.disabled = false;
  }
}
eventForm.onsubmit = artistForm.onsubmit = submitEditor;
workspace.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.create) {
    openEditor(button.dataset.create);
    return;
  }
  const concert = dashboard.events.find(
    (item) => item.id === button.closest("tr")?.dataset.id,
  );
  if (
    button.hasAttribute("data-edit-event") ||
    button.hasAttribute("data-copy-event")
  ) {
    openEditor("event", concert, button.hasAttribute("data-copy-event"));
    return;
  }
  const removingConcert = button.hasAttribute("data-remove-event");
  if (!removingConcert && !button.dataset.removeArtist) return;
  if (
    !window.confirm(
      removingConcert
        ? "Отменить концерт «" + concert.name + "» и выданные билеты?"
        : "Удалить артиста из списка?",
    )
  )
    return;
  button.disabled = true;
  try {
    await requestApi(
      "admin/" + (removingConcert ? "remove-event" : "remove-artist"),
      { id: removingConcert ? concert.id : button.dataset.removeArtist },
    );
    await loadPanel();
    notice.textContent = removingConcert
      ? "Концерт отменён."
      : "Артист удалён.";
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
loginForm.onsubmit = async (event) => {
  event.preventDefault();
  const button = select("button", loginForm);
  button.disabled = true;
  try {
    await requestApi("login", Object.fromEntries(new FormData(loginForm)));
    await loadPanel();
    loginForm.reset();
    notice.textContent = "";
  } catch (error) {
    notice.textContent =
      error.status === 403
        ? "У аккаунта нет прав администратора."
        : error.message;
  } finally {
    button.disabled = false;
  }
};
select("#admin-logout").onclick = async () => {
  try {
    await requestApi("logout", {});
    location.replace("admin.html");
  } catch (error) {
    notice.textContent = error.message;
  }
};
function resetVerdict(message = "") {
  lookupGeneration++;
  setText(verdict, "h3", message);
  setText(verdict, "p", "");
  setText(verdict, "small", "");
  select("#redeem").hidden = true;
  return lookupGeneration;
}
function showVerdict(ticket) {
  setText(verdict, "h3", ticket.label);
  setText(
    verdict,
    "p",
    [
      "№ " + ticket.code,
      ticket.name,
      ticket.date + " " + ticket.time,
      ticket.venue,
      formatSeat(ticket.seat),
    ].join(" · "),
  );
  setText(
    verdict,
    "small",
    ticket.usedAt
      ? "Вход отмечен " + new Date(ticket.usedAt).toLocaleString("ru-RU")
      : "",
  );
  const redeem = select("#redeem");
  redeem.hidden = ticket.status !== "valid";
  redeem.dataset.code = ticket.code;
  redeem.disabled = false;
}
async function checkAdmission(route, code) {
  const generation = resetVerdict("Проверяем…");
  try {
    const ticket = await requestApi("admin/" + route, { code });
    if (route === "ticket-redeem") {
      dashboard.checkedIn++;
      setText(
        workspace,
        '[data-metric="used"]',
        dashboard.checkedIn.toLocaleString("ru-RU"),
      );
    }
    if (generation === lookupGeneration) showVerdict(ticket);
  } catch (error) {
    if (generation === lookupGeneration) resetVerdict(error.message);
  }
}
const lookupForm = select("#lookup");
lookupForm.oninput = () => resetVerdict();
lookupForm.onsubmit = (event) => {
  event.preventDefault();
  checkAdmission("ticket-check", lookupForm.elements.code.value);
};
select("#redeem").onclick = (event) =>
  checkAdmission("ticket-redeem", event.currentTarget.dataset.code);
loadPanel().catch((error) => {
  loginForm.hidden = false;
  if (error.status !== 403) notice.textContent = error.message;
});
