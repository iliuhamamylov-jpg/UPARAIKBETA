class BookingDialog {
  constructor() {
    this.panel = select("#panel");
    this.selectedSeats = new Set();
    this.panel.addEventListener("click", (event) => {
      if (event.target === this.panel || event.target.closest("[data-close]"))
        this.panel.close();
    });
  }
  show(templateId, { concert, isWide = false } = {}) {
    const content = cloneTemplate(templateId),
      container = select(".dialog-content", this.panel);
    container.replaceChildren();
    if (concert) {
      const poster = cloneTemplate("poster");
      setPhoto(select("img", poster), concert);
      setText(poster, "strong", concert.name);
      container.append(poster);
    }
    container.append(content);
    this.panel.classList.toggle("wide", isWide);
    if (!this.panel.open) this.panel.showModal();
    return content;
  }
  showConcert(id) {
    this.concert = findConcert(id);
    const concert = this.concert,
      content = this.show("details", { concert });
    setText(content, "h2", "Концерт " + concert.name);
    setText(content, "[data-date]", formatDate(concert));
    setText(content, "[data-time]", concert.time);
    setText(content, "[data-venue]", concert.venue);
    setText(content, "[data-artist]", concert.name + " · " + concert.genre);
    setText(content, ".buy-row b", "от " + formatPrice(concert.price));
  }
  async openHall() {
    const seatMap = await requestApi("hall/" + this.concert.id);
    this.prices = seatMap.prices;
    this.selectedSeats.clear();
    const occupied = new Set(seatMap.occupied);
    const content = this.show("hall", { concert: this.concert, isWide: true });
    const rows = select("[data-rows]", content);
    for (let rowIndex = 0; rowIndex < 12; rowIndex++) {
      const row = cloneTemplate("seat-row");
      setText(row, "small", rowIndex + 1);
      for (let column = 0; column < 16; column++) {
        const index = rowIndex * 16 + column,
          button = cloneTemplate("seat");
        button.dataset.seat = index;
        button.disabled = occupied.has(index);
        button.setAttribute(
          "aria-label",
          formatSeat(index) + ", " + formatPrice(this.prices[index]),
        );
        row.append(button);
      }
      rows.append(row);
    }
    setText(
      content,
      "aside small",
      "Свободно " +
        (this.prices.length - occupied.size) +
        " из " +
        this.prices.length,
    );
    this.updateSelection();
  }
  toggleSeat(button) {
    const index = Number(button.dataset.seat);
    if (this.selectedSeats.has(index)) this.selectedSeats.delete(index);
    else this.selectedSeats.add(index);
    button.setAttribute("aria-pressed", this.selectedSeats.has(index));
    this.updateSelection();
  }
  get total() {
    return [...this.selectedSeats].reduce(
      (sum, index) => sum + this.prices[index],
      0,
    );
  }
  updateSelection() {
    const summary = select("#panel [data-selected]");
    summary.textContent =
      [...this.selectedSeats]
        .map(
          (index) =>
            formatSeat(index) + " · " + formatPrice(this.prices[index]),
        )
        .join("\n") || "Выберите место на схеме.";
    setText(this.panel, "aside b", "Итого　" + formatPrice(this.total));
    select("[data-confirm]", this.panel).disabled = !this.selectedSeats.size;
  }
  confirmBooking() {
    const content = this.show("confirmation");
    setText(content, "h3", this.concert.name);
    setText(
      content,
      "[data-meta]",
      formatDate(this.concert) + " · " + this.concert.venue,
    );
    setText(
      content,
      "[data-selected]",
      [...this.selectedSeats].map(formatSeat).join("\n"),
    );
    setText(content, "b", formatPrice(this.total));
  }
  async completeBooking() {
    const button = select("[data-book]", this.panel);
    if (button) button.disabled = true;
    try {
      await account.update("book", {
        id: this.concert.id,
        seats: [...this.selectedSeats],
        total: this.total,
      });
      this.show("booked");
    } catch (error) {
      if (error.status === 409) await this.openHall();
      else this.confirmBooking();
      throw error;
    }
  }
  async showTicket(key) {
    await account.refresh();
    const ticket = account.tickets.find((ticket) => ticket.key === key);
    if (!ticket) throw Error("Билет не найден.");
    const concert = findConcert(ticket.id),
      content = this.show("ticket-detail", { concert });
    setText(content, "h3", concert.name);
    setText(
      content,
      "[data-meta]",
      [formatDate(concert), concert.time, concert.venue].join(" · "),
    );
    setText(content, "[data-price]", formatPrice(ticket.total));
    setText(content, "[data-status]", ticketStatus(ticket));
    const cancel = select("[data-cancel]", content);
    cancel.dataset.cancel = key;
    cancel.hidden =
      ticket.status !== "active" ||
      ticket.admissions.some((admission) => admission.usedAt);
    for (const admission of ticket.admissions) {
      const section = cloneTemplate("admission");
      setText(section, "h3", formatSeat(admission.seat));
      setText(section, "strong", admission.code);
      if (admission.usedAt)
        setText(
          section,
          "b",
          "Использован · " + new Date(admission.usedAt).toLocaleString("ru-RU"),
        );
      else if (ticket.status === "active") {
        const image = select("img", section);
        image.hidden = Boolean(admission.offer);
        const sell = select("[data-sell]", section);
        sell.hidden =
          concert.date.toLocaleDateString("sv-SE") <
          new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
        sell.textContent = admission.offer
          ? "Снять с продажи"
          : "Выставить за " + formatPrice(admission.faceValue);
        sell.onclick = async () => {
          if (
            !admission.offer &&
            !window.confirm(
              "Выставить билет? До снятия с продажи вход по нему заблокирован. После покупки билет перейдёт другому пользователю. Расчёты между пользователями проходят вне сайта.",
            )
          )
            return;
          sell.disabled = true;
          try {
            await requestApi(
              admission.offer ? "resale/withdraw" : "resale/list",
              admission.offer
                ? { id: admission.offer }
                : { code: admission.code },
            );
            await this.showTicket(key);
          } catch (error) {
            window.alert(error.message);
          } finally {
            sell.disabled = false;
          }
        };
        if (admission.offer)
          setText(
            section,
            "b",
            "На продаже · " + formatPrice(admission.faceValue),
          );
        image.src = "/api/qr/" + admission.code;
      }
      select("[data-admissions]", content).append(section);
    }
  }
}
const bookingDialog = new BookingDialog();
function bindForm(form, submit) {
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter || select(".pill", form);
    button.disabled = true;
    try {
      await submit(Object.fromEntries(new FormData(form)));
    } catch (error) {
      const alert = select("[role=alert]", form);
      if (alert) alert.textContent = error.message;
      else window.alert(error.message);
    } finally {
      button.disabled = false;
    }
  };
}
function refreshProfilePage() {
  if (document.body.dataset.page === "profile") renderProfile();
}
function showAuth(isRegister = false, onSuccess) {
  const form = bookingDialog.show("auth-form");
  select("[data-name]", form).hidden = !isRegister;
  form.elements.name.required = isRegister;
  form.elements.password.autocomplete = isRegister
    ? "new-password"
    : "current-password";
  setText(form, "h2", isRegister ? "Регистрация" : "Вход в кабинет");
  setText(form, ".pill", isRegister ? "Создать аккаунт" : "Войти");
  setText(
    form,
    ".auth-switch",
    isRegister ? "Уже есть аккаунт" : "Зарегистрироваться",
  );
  select(".auth-switch", form).onclick = () => showAuth(!isRegister, onSuccess);
  bindForm(form, async (values) => {
    await account.update(isRegister ? "register" : "login", values);
    bookingDialog.panel.close();
    refreshProfilePage();
    await onSuccess?.();
  });
}
function requireAccount(action) {
  return account.profile ? action() : showAuth(false, action);
}
function editProfile() {
  const form = bookingDialog.show("edit-profile");
  for (const key of ["name", "email", "phone"])
    form.elements[key].value = account.profile[key];
  bindForm(form, async (values) => {
    await account.update("profile", values);
    bookingDialog.panel.close();
    renderProfile();
  });
}
async function toggleFavorite(id) {
  await account.update("favorite", {
    id,
    enabled: !account.favorites.includes(id),
  });
  document
    .querySelectorAll("[data-fav]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        account.favorites.includes(button.dataset.fav),
      ),
    );
  refreshProfilePage();
}
const actions = {
  open: (button) => bookingDialog.showConcert(button.dataset.open),
  fav: (button) => requireAccount(() => toggleFavorite(button.dataset.fav)),
  login: () => showAuth(),
  logout: async () => {
    await account.update("logout", {});
    renderProfile();
  },
  edit: editProfile,
  seats: () => bookingDialog.openHall(),
  seat: (button) => bookingDialog.toggleSeat(button),
  confirm: () => bookingDialog.confirmBooking(),
  book: () => requireAccount(() => bookingDialog.completeBooking()),
  ticket: (button) => bookingDialog.showTicket(button.dataset.ticket),
  cancel: async (button) => {
    await account.update("cancel", { key: button.dataset.cancel });
    bookingDialog.panel.close();
    renderProfile();
  },
};
async function initializePage() {
  const page = document.body.dataset.page;
  const footer = select(".site-footer");
  select('[data-page="' + page + '"]', footer)?.setAttribute(
    "aria-current",
    "page",
  );
  footer.addEventListener("click", (event) => {
    const trigger = event.target.closest("button[aria-controls]");
    if (trigger)
      document
        .getElementById(trigger.getAttribute("aria-controls"))
        .showModal();
  });
  if (page === "home" && ["#concerts", "#profile"].includes(location.hash)) {
    location.replace(location.hash.slice(1) + ".html");
    return;
  }
  const [catalog] = await Promise.all([
    requestApi("catalog"),
    account.refresh(),
  ]);
  concerts = catalog.map(parseConcert);
  ({
    home: initializeHome,
    catalog: initializeCatalog,
    profile: renderProfile,
  })[page]();
  if (page === "catalog") initializeResale();
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const action = Object.keys(button.dataset).find((key) =>
      Object.hasOwn(actions, key),
    );
    if (action) {
      try {
        await actions[action](button);
      } catch (error) {
        window.alert(error.message);
      }
    }
  });
}
initializePage().catch((error) => {
  select("#main").textContent = "Не удалось загрузить афишу. " + error.message;
});
