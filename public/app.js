const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const user = tg?.initDataUnsafe?.user || {
  id: "demo_user",
  first_name: "User"
};

const state = {
  balance: 0,
  completed: 0,
  tasks: []
};

const $ = (selector) => document.querySelector(selector);

function setText(selector, text) {
  const el = $(selector);
  if (el) el.textContent = text;
}

function updateProfileUI() {
  setText("#balance", `${state.balance.toFixed(2)}₽`);
  setText("#balanceBig", `${state.balance.toFixed(2)}₽`);
  setText("#completed", state.completed);
}

async function loadProfile() {
  const res = await fetch(`/api/profile?user_id=${encodeURIComponent(user.id)}`);
  const data = await res.json();

  state.balance = Number(data.balance || 0);
  state.completed = Number(data.completed || 0);

  updateProfileUI();
}

async function loadTasks() {
  const list = $("#taskList");
  list.innerHTML = `<div class="task">Загружаем задания...</div>`;

  try {
    const res = await fetch(`/api/tasks?user_id=${encodeURIComponent(user.id)}`);
    const data = await res.json();

    state.tasks = data.tasks || [];
    renderTasks();
  } catch (e) {
    list.innerHTML = `<div class="task">Ошибка загрузки заданий</div>`;
  }
}

function renderTasks() {
  const list = $("#taskList");

  if (!state.tasks.length) {
    list.innerHTML = `<div class="task">Пока нет доступных заданий. Попробуй позже.</div>`;
    return;
  }

  list.innerHTML = state.tasks.map(task => `
    <article class="task">
      <div class="task-top">
        <div>
          <div class="task-title">${task.title}</div>
          <div style="color: var(--muted); margin-top: 5px;">Тип: ${task.type || "задание"}</div>
        </div>
        <div class="reward">+${Number(task.reward || 0).toFixed(2)}₽</div>
      </div>

      <div class="task-actions">
        <button class="secondary-btn" onclick="openTask('${task.url}')">Перейти</button>
        <button class="primary-btn" onclick="checkTask('${task.id}')">Проверить</button>
      </div>
    </article>
  `).join("");
}

window.openTask = function(url) {
  tg?.openTelegramLink?.(url);
  if (!tg) window.open(url, "_blank");
};

window.checkTask = async function(taskId) {
  const res = await fetch("/api/check-task", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      user_id: user.id,
      task_id: taskId
    })
  });

  const data = await res.json();

  tg?.showAlert?.(data.message || "Проверка выполнена");

  if (data.ok) {
    state.balance += Number(data.reward || 0);
    state.completed += 1;
    updateProfileUI();
  }
};

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));

    btn.classList.add("active");
    document.getElementById(btn.dataset.page).classList.add("active");
  });
});

$("#refreshTasks").addEventListener("click", loadTasks);

$("#copyRef").addEventListener("click", async () => {
  const link = `https://t.me/YOUR_BOT_USERNAME?start=${user.id}`;

  try {
    await navigator.clipboard.writeText(link);
    tg?.showAlert?.("Ссылка скопирована");
  } catch {
    tg?.showAlert?.(link);
  }
});

loadProfile();
loadTasks();
