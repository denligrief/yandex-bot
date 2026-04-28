const $ = (selector) => document.querySelector(selector);

const state = {
  token: sessionStorage.getItem("subzon_admin_token") || "",
  withdrawals: [],
  selectedUserId: null,
  selectedUser: null
};

function setMessage(text, type = "info") {
  const el = $("#adminMessage");
  if (!el) return;
  el.textContent = text;
  el.className = `admin-message ${type}`;
}

function formatMoney(value) {
  return `${Number(value || 0).toFixed(2)} ₽`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function statusLabel(status) {
  const labels = {
    pending: "На проверке",
    approved: "Одобрена",
    paid: "Выплачена",
    rejected: "Отклонена"
  };

  return labels[status] || status;
}

async function adminFetch(url, options = {}) {
  if (!state.token) {
    throw new Error("Сначала введи ADMIN_TOKEN");
  }

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || "Запрос не выполнен");
  }

  return data;
}

function renderWithdrawals() {
  const list = $("#adminWithdrawals");
  if (!list) return;

  if (!state.withdrawals.length) {
    list.replaceChildren(createEmptyState("Заявок нет"));
    return;
  }

  const fragment = document.createDocumentFragment();

  state.withdrawals.forEach((request) => {
    const card = document.createElement("article");
    card.className = `admin-withdrawal status-${request.status}`;

    const main = document.createElement("div");
    main.className = "admin-withdrawal-main";

    const title = document.createElement("div");
    title.className = "admin-withdrawal-title";

    const amount = document.createElement("strong");
    amount.textContent = formatMoney(request.amount);

    const badge = document.createElement("span");
    badge.textContent = statusLabel(request.status);

    title.append(amount, badge);

    const meta = document.createElement("p");
    const username = request.username ? `@${request.username}` : request.first_name || "без имени";
    meta.textContent = `ID ${request.user_id} · ${username} · ${formatDate(request.created_at)}`;

    const details = document.createElement("p");
    details.textContent = `${request.method}: ${request.account}`;

    main.append(title, meta, details);

    const actions = document.createElement("div");
    actions.className = "admin-actions";

    [
      ["approved", "Одобрить"],
      ["paid", "Выплачено"],
      ["rejected", "Отклонить"]
    ].forEach(([status, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = status === "rejected" ? "danger-btn" : "secondary-btn";
      button.textContent = label;
      button.disabled = request.status === status || request.status === "rejected";
      button.addEventListener("click", () => updateWithdrawal(request.id, status));
      actions.append(button);
    });

    card.append(main, actions);
    fragment.append(card);
  });

  list.replaceChildren(fragment);
}

function renderUserCard() {
  const root = $("#adminUserCard");
  if (!root) return;

  if (!state.selectedUser) {
    root.replaceChildren(createEmptyState("Найди пользователя по Telegram ID"));
    return;
  }

  const { profile, withdrawals } = state.selectedUser;
  const wrap = document.createElement("div");
  wrap.className = "admin-user-details";

  const head = document.createElement("div");
  head.className = "admin-user-head";

  const title = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = profile.username ? `@${profile.username}` : profile.first_name || `ID ${profile.user_id}`;
  const meta = document.createElement("span");
  meta.textContent = `Telegram ID: ${profile.user_id}`;
  title.append(name, meta);

  const balance = document.createElement("b");
  balance.textContent = formatMoney(profile.balance);
  head.append(title, balance);

  const metrics = document.createElement("div");
  metrics.className = "admin-user-metrics";
  [
    ["Баланс", formatMoney(profile.balance)],
    ["Заданий", profile.completed],
    ["Рефералка", formatMoney(profile.referral_earned)],
    ["Друзей", profile.referrals_count || 0]
  ].forEach(([label, value]) => {
    const item = document.createElement("article");
    const span = document.createElement("span");
    span.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    item.append(span, strong);
    metrics.append(item);
  });

  const actions = document.createElement("form");
  actions.className = "admin-user-balance-form";
  actions.innerHTML = `
    <input id="userBalanceAmount" type="number" min="0.01" step="0.01" placeholder="Сумма" />
    <input id="userBalanceReason" type="text" placeholder="Комментарий" />
    <button class="primary-btn" type="button" data-action="add">Начислить</button>
    <button class="danger-btn" type="button" data-action="subtract">Списать</button>
  `;

  actions.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => changeSelectedUserBalance(button.dataset.action));
  });

  const historyTitle = document.createElement("h3");
  historyTitle.textContent = "Заявки пользователя";

  const history = document.createElement("div");
  history.className = "admin-user-withdrawals";

  if (!withdrawals?.length) {
    history.append(createEmptyState("Заявок пока нет"));
  } else {
    withdrawals.forEach((request) => {
      const item = document.createElement("article");
      item.className = `withdraw-item status-${request.status}`;
      item.innerHTML = `
        <div>
          <strong>${formatMoney(request.amount)} · ${request.method}</strong>
          <span>${statusLabel(request.status)} · ${formatDate(request.created_at)}</span>
          <p>${request.account}</p>
        </div>
        <b>${statusLabel(request.status)}</b>
      `;
      history.append(item);
    });
  }

  const operationsTitle = document.createElement("h3");
  operationsTitle.textContent = "Операции";

  const operations = document.createElement("div");
  operations.className = "admin-user-operations";

  if (!state.selectedUser.operations?.length) {
    operations.append(createEmptyState("Операций пока нет"));
  } else {
    state.selectedUser.operations.forEach((operation) => {
      const item = document.createElement("article");
      item.className = `operation-item ${Number(operation.amount) >= 0 ? "income" : "expense"}`;
      item.innerHTML = `
        <div>
          <strong>${operation.title || "Операция"}</strong>
          <span>${[operation.meta, formatDate(operation.created_at)].filter(Boolean).join(" · ")}</span>
        </div>
        <b>${Number(operation.amount) >= 0 ? "+" : ""}${formatMoney(operation.amount)}</b>
      `;
      operations.append(item);
    });
  }

  wrap.append(head, metrics, actions, operationsTitle, operations, historyTitle, history);
  root.replaceChildren(wrap);
}

function createEmptyState(text) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = text;
  return empty;
}

async function loadWithdrawals() {
  try {
    const status = $("#withdrawStatusFilter")?.value || "pending";
    const data = await adminFetch(`/api/admin/withdrawals?status=${encodeURIComponent(status)}`);
    state.withdrawals = Array.isArray(data.requests) ? data.requests : [];
    renderWithdrawals();
    setMessage("Заявки обновлены", "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function loadUserCard(userId) {
  try {
    const data = await adminFetch(`/api/admin/users/${encodeURIComponent(userId)}`);
    state.selectedUserId = Number(data.profile.user_id);
    state.selectedUser = data;
    renderUserCard();
    setMessage(`Пользователь ${data.profile.user_id} загружен`, "success");
  } catch (error) {
    state.selectedUser = null;
    renderUserCard();
    setMessage(error.message, "error");
  }
}

async function changeSelectedUserBalance(action) {
  if (!state.selectedUserId) {
    setMessage("Сначала найди пользователя", "error");
    return;
  }

  const amount = Number($("#userBalanceAmount")?.value || 0);
  const reason = $("#userBalanceReason")?.value || "admin";

  if (!amount) {
    setMessage("Укажи сумму", "error");
    return;
  }

  const endpoint = action === "subtract" ? "/api/admin/balance/subtract" : "/api/admin/balance";

  try {
    await adminFetch(endpoint, {
      method: "POST",
      body: JSON.stringify({
        user_id: state.selectedUserId,
        amount,
        reason
      })
    });
    await loadUserCard(state.selectedUserId);
    setMessage(action === "subtract" ? "Баланс списан" : "Баланс начислен", "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function updateWithdrawal(id, status) {
  const comment = status === "rejected"
    ? prompt("Комментарий к отклонению", "Отклонено администратором")
    : "";

  if (status === "rejected" && comment === null) return;

  try {
    await adminFetch(`/api/admin/withdrawals/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status, comment })
    });
    setMessage(`Заявка #${id}: ${statusLabel(status)}`, "success");
    await loadWithdrawals();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

$("#adminTokenForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = $("#adminToken")?.value.trim() || "";
  sessionStorage.setItem("subzon_admin_token", state.token);
  await loadWithdrawals();
});

$("#grantBalanceForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const userId = Number($("#grantUserId")?.value || 0);
  const amount = Number($("#grantAmount")?.value || 0);
  const reason = $("#grantReason")?.value || "admin";

  if (!userId || !amount) {
    setMessage("Укажи Telegram ID и сумму", "error");
    return;
  }

  try {
    const data = await adminFetch("/api/admin/balance", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        amount,
        reason
      })
    });

    setMessage(`Баланс пользователя ${data.profile.user_id}: ${formatMoney(data.profile.balance)}`, "success");
    $("#grantBalanceForm")?.reset();
  } catch (error) {
    setMessage(error.message, "error");
  }
});

$("#userSearchForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const userId = Number($("#userSearchId")?.value || 0);

  if (!userId) {
    setMessage("Укажи Telegram ID", "error");
    return;
  }

  await loadUserCard(userId);
});

$("#refreshAdmin")?.addEventListener("click", loadWithdrawals);
$("#withdrawStatusFilter")?.addEventListener("change", loadWithdrawals);

if (state.token) {
  const input = $("#adminToken");
  if (input) input.value = state.token;
  loadWithdrawals();
}
