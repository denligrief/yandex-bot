const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const user = tg?.initDataUnsafe?.user || {
  id: "demo_user",
  first_name: "Гость"
};

const state = {
  balance: 0,
  completed: 0,
  tasks: [],
  checking: new Set()
};

const MIN_WITHDRAW = 50;
const $ = (selector) => document.querySelector(selector);

function getUserParams() {
  const params = new URLSearchParams({
    user_id: String(user.id),
    chat_id: String(user.id),
    first_name: user.first_name || "",
    username: user.username || "",
    language_code: user.language_code || "ru",
    is_premium: String(Boolean(user.is_premium))
  });

  return params.toString();
}

function formatMoney(value, digits = 2) {
  return `${Number(value || 0).toFixed(digits)} ₽`;
}

function setText(selector, text) {
  const el = $(selector);
  if (el) el.textContent = text;
}

function updateProfileUI() {
  const progress = Math.min((state.balance / MIN_WITHDRAW) * 100, 100);
  const missing = Math.max(MIN_WITHDRAW - state.balance, 0);

  setText("#balance", formatMoney(state.balance));
  setText("#balanceBig", formatMoney(state.balance));
  setText("#balanceShort", formatMoney(state.balance, state.balance > 9 ? 0 : 2));
  setText("#completed", state.completed);
  setText("#withdrawHint", missing > 0
    ? `До минимального вывода осталось ${formatMoney(missing)}`
    : "Можно отправлять заявку на вывод");

  const progressBar = $("#withdrawProgress");
  if (progressBar) progressBar.style.width = `${progress}%`;
}

function createEmptyState(text) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = text;
  return empty;
}

async function loadProfile() {
  try {
    const res = await fetch(`/api/profile?user_id=${encodeURIComponent(user.id)}`);
    const data = await res.json();

    state.balance = Number(data.balance || 0);
    state.completed = Number(data.completed || 0);
    updateProfileUI();
  } catch {
    tg?.showAlert?.("Не удалось загрузить профиль");
  }
}

async function loadTasks() {
  const list = $("#taskList");
  const refresh = $("#refreshTasks");

  list.replaceChildren(createEmptyState("Загружаем свежие подписки..."));
  refresh?.classList.add("loading");

  try {
    const res = await fetch(`/api/tasks?${getUserParams()}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Ошибка загрузки SubGram");
    }

    state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    renderTasks();

    if (data.warning) {
      tg?.showAlert?.(data.warning);
    }
  } catch (error) {
    list.replaceChildren(createEmptyState(error.message || "Не получилось загрузить подписки. Попробуй ещё раз."));
  } finally {
    refresh?.classList.remove("loading");
  }
}

function renderTasks() {
  const list = $("#taskList");
  setText("#taskCount", state.tasks.length);

  if (!state.tasks.length) {
    list.replaceChildren(createEmptyState("SubGram не вернул доступных подписок. Загляни чуть позже."));
    return;
  }

  const fragment = document.createDocumentFragment();

  state.tasks.forEach((task, index) => {
    const card = document.createElement("article");
    card.className = "task";

    const top = document.createElement("div");
    top.className = "task-top";

    const info = document.createElement("div");
    info.className = "task-info";

    const title = document.createElement("h3");
    title.textContent = task.title || "Подписка";

    const meta = document.createElement("p");
    meta.textContent = task.source === "subgram" ? "SubGram подписка" : "Демо-задание";

    const reward = document.createElement("strong");
    reward.className = "reward";
    reward.textContent = `+${formatMoney(task.reward)}`;

    info.append(title, meta);
    top.append(info, reward);

    const footer = document.createElement("div");
    footer.className = "task-actions";

    const openButton = document.createElement("button");
    openButton.className = "secondary-btn";
    openButton.type = "button";
    openButton.textContent = "Перейти";
    openButton.disabled = !task.url;
    openButton.addEventListener("click", () => openTask(task.url));

    const checkButton = document.createElement("button");
    checkButton.className = "primary-btn";
    checkButton.type = "button";
    checkButton.textContent = state.checking.has(task.id) ? "Проверяем" : "Проверить";
    checkButton.disabled = state.checking.has(task.id) || !task.url;
    checkButton.addEventListener("click", () => checkTask(task));

    const number = document.createElement("span");
    number.className = "task-number";
    number.textContent = String(index + 1).padStart(2, "0");

    footer.append(openButton, checkButton);
    card.append(number, top, footer);
    fragment.append(card);
  });

  list.replaceChildren(fragment);
}

function openTask(url) {
  if (!url) return;
  tg?.openTelegramLink?.(url);
  if (!tg) window.open(url, "_blank", "noopener,noreferrer");
}

async function checkTask(task) {
  if (!task?.id || state.checking.has(task.id)) return;

  state.checking.add(task.id);
  renderTasks();

  try {
    const res = await fetch("/api/check-task", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        user_id: user.id,
        chat_id: user.id,
        task_id: task.id,
        task_url: task.url
      })
    });

    const data = await res.json();
    tg?.showAlert?.(data.message || "Проверка выполнена");

    if (data.ok) {
      state.balance += Number(data.reward || 0);
      state.completed += 1;
      state.tasks = state.tasks.filter((item) => item.id !== task.id);
      updateProfileUI();
    }
  } catch {
    tg?.showAlert?.("Не удалось отправить подписку на проверку");
  } finally {
    state.checking.delete(task.id);
    renderTasks();
  }
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
    document.querySelectorAll(".page").forEach((page) => page.classList.remove("active"));

    btn.classList.add("active");
    document.getElementById(btn.dataset.page)?.classList.add("active");
  });
});

$("#refreshTasks")?.addEventListener("click", loadTasks);

$("#copyRef")?.addEventListener("click", async () => {
  const link = `https://t.me/YOUR_BOT_USERNAME?start=${user.id}`;

  try {
    await navigator.clipboard.writeText(link);
    tg?.showAlert?.("Ссылка скопирована");
  } catch {
    tg?.showAlert?.(link);
  }
});

setText("#greeting", `${user.first_name || "Гость"}, выбирай подписку`);
updateProfileUI();
loadProfile();
loadTasks();
