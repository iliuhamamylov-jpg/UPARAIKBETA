const { executeStatement } = require("./db.cjs");
const email = (process.argv[2] || "").trim().toLowerCase();
if (
  !email ||
  !executeStatement("UPDATE users SET role='admin' WHERE email=?", email)
    .changes
) {
  console.error(
    "Сначала зарегистрируйтесь на сайте. Затем: npm run admin -- ваш@email.ru",
  );
  process.exitCode = 1;
} else
  console.log(
    "Права администратора предоставлены. Обновите страницу кабинета.",
  );
