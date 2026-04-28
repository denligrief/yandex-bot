const $ = (selector) => document.querySelector(selector);

const state = {
  token: sessionStorage.getItem("subzon_admin_token") || "",
  withdrawals: []
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

$("#refreshAdmin")?.addEventListener("click", loadWithdrawals);
$("#withdrawStatusFilter")?.addEventListener("change", loadWithdrawals);

if (state.token) {
  const input = $("#adminToken");
  if (input) input.value = state.token;
  loadWithdrawals();
}
