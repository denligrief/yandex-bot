const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const user = tg?.initDataUnsafe?.user || {
  id: 123456789,
  first_name: "Гость"
};

const state = {
  balance: 0,
  completed: 0,
  tasks: [],
  withdrawals: [],
  operations: [],
  referrals: {
    percent: 10,
    referrals_count: 0,
    referral_earned: 0,
    referrals: [],
    link: null
  },
  withdrawSubmitting: false,
  checking: new Set(),
  stats: {
    online: 0,
    total_users: 0,
    total_earned: 0
  }
};

const MIN_WITHDRAW = 50;
const $ = (selector) => document.querySelector(selector);
const telegramHeaders = tg?.initData
  ? { "X-Telegram-Init-Data": tg.initData }
  : {};

function getJson(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...telegramHeaders,
      ...options.headers
    }
  });
}

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

function formatNumber(value) {
  return new Intl.NumberFormat("ru-RU").format(Number(value || 0));
}

function setText(selector, text) {
  const el = $(selector);
  if (el) el.textContent = text;
}

function updateProfileFromData(data) {
  state.balance = Number(data.balance || 0);
  state.completed = Number(data.completed || 0);
  updateProfileUI();
}

function updateProfileUI() {
  const progress = Math.min((state.balance / MIN_WITHDRAW) * 100, 100);
  const missing = Math.max(MIN_WITHDRAW - state.balance, 0);
  const averageReward = state.tasks[0]?.reward ? Number(state.tasks[0].reward) : 0.25;
  const tasksLeft = averageReward > 0 ? Math.ceil(missing / averageReward) : 0;

  setText("#balanceHero", formatMoney(state.balance));
  setText("#balanceBig", formatMoney(state.balance));
  setText("#balanceShort", formatMoney(state.balance, state.balance > 9 ? 0 : 2));
  setText("#completed", state.completed);
  setText("#balanceCompleted", state.completed);
  setText("#cardHolder", String(user.first_name || "Guest").toUpperCase());
  setText("#withdrawHint", missing > 0
    ? `До вывода осталось ${formatMoney(missing)}`
    : "Минимальная сумма набрана");
  setText("#withdrawPercent", `${Math.round(progress)}%`);
  setText("#withdrawTasksHint", missing > 0
    ? `Примерно ${tasksLeft} заданий до первой выплаты`
    : "Можно отправлять заявку на выплату");
  setText("#lastReward", state.completed > 0 ? formatMoney(averageReward) : "0 ₽");
  setText("#withdrawStatus", missing > 0 ? "Закрыт" : "Готово");

  const progressBar = $("#withdrawProgress");
  if (progressBar) progressBar.style.width = `${progress}%`;

  const withdrawButton = $("#withdrawButton");
  if (withdrawButton) {
    withdrawButton.disabled = missing > 0;
    withdrawButton.textContent = missing > 0 ? `Нужно еще ${formatMoney(missing)}` : "Вывести";
  }

  const withdrawAmount = $("#withdrawAmount");
  if (withdrawAmount) {
    withdrawAmount.max = String(Math.max(state.balance, 0));
    withdrawAmount.placeholder = state.balance >= MIN_WITHDRAW ? formatMoney(Math.min(state.balance, MIN_WITHDRAW)).replace(" ₽", "") : "50.00";
  }

  const sendWithdrawRequest = $("#sendWithdrawRequest");
  if (sendWithdrawRequest) {
    sendWithdrawRequest.disabled = state.withdrawSubmitting || state.balance < MIN_WITHDRAW;
    sendWithdrawRequest.textContent = state.withdrawSubmitting
      ? "Отправляем"
      : state.balance < MIN_WITHDRAW
        ? `Нужно еще ${formatMoney(missing)}`
        : "Создать заявку";
  }
}

function updateStatsUI() {
  setText("#onlineUsers", formatNumber(state.stats.online));
  setText("#totalUsers", formatNumber(state.stats.total_users));
  setText("#totalEarned", formatMoney(state.stats.total_earned));
}

function updateReferralUI() {
  const data = state.referrals;

  setText("#refCount", formatNumber(data.referrals_count));
  setText("#refEarned", formatMoney(data.referral_earned));
  setText("#refPercent", `${Number(data.percent || 10)}%`);
  setText("#refLinkText", data.link || "Добавь BOT_USERNAME на сервере, чтобы ссылка появилась");

  const list = $("#refList");
  if (!list) return;

  const referrals = Array.isArray(data.referrals) ? data.referrals : [];

  if (!referrals.length) {
    list.replaceChildren(createEmptyState("Пока никто не пришел по твоей ссылке"));
    return;
  }

  const fragment = document.createDocumentFragment();

  referrals.forEach((referral) => {
    const item = document.createElement("article");
    item.className = "ref-item";

    const name = document.createElement("strong");
    name.textContent = referral.username ? `@${referral.username}` : referral.first_name || `ID ${referral.user_id}`;

    const meta = document.createElement("span");
    meta.textContent = `Выполнено заданий: ${formatNumber(referral.completed)}`;

    item.append(name, meta);
    fragment.append(item);
  });

  list.replaceChildren(fragment);
}

async function loadReferrals() {
  try {
    const res = await getJson(`/api/referrals?${getUserParams()}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Не удалось загрузить рефералов");
    }

    state.referrals = {
      percent: Number(data.percent || 10),
      referrals_count: Number(data.referrals_count || 0),
      referral_earned: Number(data.referral_earned || 0),
      referrals: Array.isArray(data.referrals) ? data.referrals : [],
      link: data.link || null
    };
  } catch {
    state.referrals = {
      ...state.referrals,
      link: state.referrals.link || null
    };
  } finally {
    updateReferralUI();
  }
}

function createEmptyState(text) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = text;
  return empty;
}

async function loadProfile() {
  try {
    const res = await getJson(`/api/profile?${getUserParams()}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Не удалось загрузить профиль");
    }

    updateProfileFromData(data);
  } catch (error) {
    tg?.showAlert?.(error.message || "Не удалось загрузить профиль");
  }
}

async function loadStats() {
  try {
    const res = await getJson("/api/stats");
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Не удалось загрузить статистику");
    }

    state.stats = {
      online: Number(data.online || 0),
      total_users: Number(data.total_users || 0),
      total_earned: Number(data.total_earned || 0)
    };
    updateStatsUI();
  } catch {
    updateStatsUI();
  }
}

function getWithdrawalStatusLabel(status) {
  const labels = {
    pending: "На проверке",
    approved: "Одобрена",
    paid: "Выплачена",
    rejected: "Отклонена"
  };

  return labels[status] || status || "На проверке";
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function renderWithdrawals() {
  const list = $("#withdrawHistory");
  if (!list) return;

  if (!state.withdrawals.length) {
    list.replaceChildren(createEmptyState("Заявок пока нет"));
    return;
  }

  const fragment = document.createDocumentFragment();

  state.withdrawals.forEach((request) => {
    const item = document.createElement("article");
    item.className = `withdraw-item status-${request.status || "pending"}`;

    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${formatMoney(request.amount)} · ${request.method || "Вывод"}`;

    const meta = document.createElement("span");
    meta.textContent = `${getWithdrawalStatusLabel(request.status)}${request.created_at ? ` · ${formatDate(request.created_at)}` : ""}`;

    const account = document.createElement("p");
    account.textContent = request.account || "";

    const status = document.createElement("b");
    status.textContent = getWithdrawalStatusLabel(request.status);

    info.append(title, meta, account);
    item.append(info, status);
    fragment.append(item);
  });

  list.replaceChildren(fragment);
}

function renderOperations() {
  const list = $("#operationList");
  if (!list) return;

  if (!state.operations.length) {
    list.replaceChildren(createEmptyState("Операций пока нет"));
    return;
  }

  const fragment = document.createDocumentFragment();

  state.operations.forEach((operation) => {
    const item = document.createElement("article");
    item.className = `operation-item ${Number(operation.amount) >= 0 ? "income" : "expense"}`;

    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = operation.title || "Операция";

    const meta = document.createElement("span");
    const date = formatDate(operation.created_at);
    meta.textContent = [operation.meta, date].filter(Boolean).join(" · ");

    const amount = document.createElement("b");
    amount.textContent = `${Number(operation.amount) >= 0 ? "+" : ""}${formatMoney(operation.amount)}`;

    info.append(title, meta);
    item.append(info, amount);
    fragment.append(item);
  });

  list.replaceChildren(fragment);
}

async function loadOperations() {
  try {
    const res = await getJson(`/api/operations?${getUserParams()}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Не удалось загрузить операции");
    }

    state.operations = Array.isArray(data.operations) ? data.operations : [];
    renderOperations();
  } catch {
    renderOperations();
  }
}

async function loadWithdrawals() {
  try {
    const res = await getJson(`/api/withdrawals?${getUserParams()}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Не удалось загрузить заявки");
    }

    state.withdrawals = Array.isArray(data.requests) ? data.requests : [];
    renderWithdrawals();
  } catch {
    renderWithdrawals();
  }
}

async function loadTasks() {
  const list = $("#taskList");
  const refresh = $("#refreshTasks");

  list.replaceChildren(createEmptyState("Загружаем свежие подписки..."));
  refresh?.classList.add("loading");

  try {
    const res = await getJson(`/api/tasks?${getUserParams()}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Ошибка загрузки SubGram");
    }

    state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    updateProfileUI();
    renderTasks();

    if (data.warning) {
      tg?.showAlert?.(data.warning);
    }
  } catch (error) {
    list.replaceChildren(createEmptyState(error.message || "Не получилось загрузить подписки. Попробуй еще раз."));
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
    const res = await getJson("/api/check-task", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: user.id,
        task_id: task.id,
        task_url: task.url,
        source: task.source
      })
    });

    const data = await res.json();
    tg?.showAlert?.(data.message || "Проверка выполнена");

    if (data.profile) {
      updateProfileFromData(data.profile);
      loadStats();
      loadOperations();
    }

    if (data.ok || data.alreadyCompleted) {
      state.tasks = state.tasks.filter((item) => item.id !== task.id);
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

$("#withdrawButton")?.addEventListener("click", () => {
  if (state.balance < MIN_WITHDRAW) {
    tg?.showAlert?.(`Минимальная сумма вывода: ${formatMoney(MIN_WITHDRAW)}`);
    return;
  }

  $("#withdrawForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#withdrawAmount")?.focus();
});

$("#focusWithdrawForm")?.addEventListener("click", () => {
  $("#withdrawForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#withdrawAmount")?.focus();
});

$("#withdrawForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (state.withdrawSubmitting) return;

  const amount = Number($("#withdrawAmount")?.value || 0);
  const method = $("#withdrawMethod")?.value || "";
  const account = $("#withdrawAccount")?.value || "";

  if (amount < MIN_WITHDRAW) {
    tg?.showAlert?.(`Минимальная сумма вывода: ${formatMoney(MIN_WITHDRAW)}`);
    return;
  }

  if (amount > state.balance) {
    tg?.showAlert?.("На балансе недостаточно средств");
    return;
  }

  if (!account.trim()) {
    tg?.showAlert?.("Укажи реквизиты для вывода");
    return;
  }

  state.withdrawSubmitting = true;
  updateProfileUI();

  try {
    const res = await getJson("/api/withdrawals", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount,
        method,
        account
      })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Не удалось создать заявку");
    }

    if (data.profile) {
      updateProfileFromData(data.profile);
    }

    if (data.request) {
      state.withdrawals = [data.request, ...state.withdrawals];
      renderWithdrawals();
    }
    await loadOperations();
    await loadStats();

    $("#withdrawForm")?.reset();
    tg?.showAlert?.(data.message || "Заявка создана");
  } catch (error) {
    tg?.showAlert?.(error.message || "Не удалось создать заявку");
  } finally {
    state.withdrawSubmitting = false;
    updateProfileUI();
  }
});

$("#copyRef")?.addEventListener("click", async () => {
  const link = state.referrals.link;

  if (!link) {
    tg?.showAlert?.("Добавь BOT_USERNAME в переменные окружения");
    return;
  }

  try {
    await navigator.clipboard.writeText(link);
    tg?.showAlert?.("Ссылка скопирована");
  } catch {
    tg?.showAlert?.(link);
  }
});

setText("#greeting", `${user.first_name || "Гость"}, выбирай подписку`);
updateProfileUI();
updateStatsUI();
updateReferralUI();
loadProfile();
loadStats();
loadWithdrawals();
loadOperations();
loadReferrals();
loadTasks();
