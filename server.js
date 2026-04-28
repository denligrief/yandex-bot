import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, Markup } from "telegraf";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
const BOT_POLLING = process.env.BOT_POLLING !== "false";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const SUBGRAM_API_KEY = process.env.SUBGRAM_API_KEY;
const SUBGRAM_API_BASE = process.env.SUBGRAM_API_BASE || "https://api.subgram.org";
const SUBGRAM_ACTION = process.env.SUBGRAM_ACTION || "task";
const SUBGRAM_MAX_SPONSORS = Number(process.env.SUBGRAM_MAX_SPONSORS || 10);
const SUBGRAM_REWARD = Number(process.env.SUBGRAM_REWARD || 0.25);
const MIN_WITHDRAW_AMOUNT = Number(process.env.MIN_WITHDRAW_AMOUNT || 50);

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_SSL = process.env.DATABASE_SSL !== "false";
const { Pool } = pg;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_SSL ? { rejectUnauthorized: false } : false
    })
  : null;

const memoryStore = {
  users: new Map(),
  completedTasks: new Set(),
  withdrawalRequests: [],
  nextWithdrawalId: 1
};

if (BOT_POLLING && !BOT_TOKEN) {
  console.error("BOT_TOKEN не указан в .env");
  process.exit(1);
}

if (BOT_POLLING && !WEBAPP_URL) {
  console.error("WEBAPP_URL не указан в .env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const bot = BOT_POLLING ? new Telegraf(BOT_TOKEN) : null;

function toTelegramId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function makeUserFromSource(source) {
  const userId = toTelegramId(source.user_id);

  if (!userId) {
    return null;
  }

  return {
    user_id: userId,
    first_name: source.first_name || null,
    username: source.username || null
  };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN is not configured" });
  }

  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : String(req.query.admin_token || req.body?.admin_token || "");

  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "admin token required" });
  }

  next();
}

function normalizeProfile(row, userId) {
  return {
    user_id: userId,
    balance: Number(row?.balance || 0),
    completed: Number(row?.completed || 0),
    referral_earned: Number(row?.referral_earned || 0)
  };
}

async function initDatabase() {
  if (!pool) {
    console.log("Database disabled, using memory store");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      first_name TEXT,
      username TEXT,
      balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      referral_earned NUMERIC(12, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS completed_tasks (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      task_key TEXT NOT NULL,
      task_url TEXT,
      source TEXT,
      reward NUMERIC(12, 2) NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (telegram_id, task_key)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      amount NUMERIC(12, 2) NOT NULL,
      method TEXT NOT NULL,
      account TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("Database ready");
}

async function ensureUser(user) {
  if (!user) return null;

  if (!pool) {
    const current = memoryStore.users.get(user.user_id) || {
      user_id: user.user_id,
      balance: 0,
      completed: 0,
      referral_earned: 0
    };

    memoryStore.users.set(user.user_id, {
      ...current,
      first_name: user.first_name,
      username: user.username,
      updated_at: Date.now()
    });

    return memoryStore.users.get(user.user_id);
  }

  const result = await pool.query(
    `
      INSERT INTO users (telegram_id, first_name, username)
      VALUES ($1, $2, $3)
      ON CONFLICT (telegram_id) DO UPDATE SET
        first_name = COALESCE(EXCLUDED.first_name, users.first_name),
        username = COALESCE(EXCLUDED.username, users.username),
        updated_at = NOW()
      RETURNING telegram_id, balance, completed, referral_earned
    `,
    [user.user_id, user.first_name, user.username]
  );

  return normalizeProfile(result.rows[0], user.user_id);
}

async function getProfile(user) {
  const existing = await ensureUser(user);
  return normalizeProfile(existing, user.user_id);
}

async function getCompletedTaskKeys(userId) {
  if (!pool) {
    const prefix = `${userId}:`;
    return new Set(
      [...memoryStore.completedTasks]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
    );
  }

  const result = await pool.query(
    "SELECT task_key FROM completed_tasks WHERE telegram_id = $1",
    [userId]
  );

  return new Set(result.rows.map((row) => row.task_key));
}

async function getServiceStats() {
  if (!pool) {
    const now = Date.now();
    const users = [...memoryStore.users.values()];
    const online = users.filter((user) => {
      const updatedAt = user.updated_at || 0;
      return now - updatedAt < 5 * 60 * 1000;
    }).length;
    const totalEarned = users.reduce((sum, user) => sum + Number(user.balance || 0), 0);

    return {
      online,
      total_users: users.length,
      total_earned: totalEarned
    };
  }

  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM users WHERE updated_at > NOW() - INTERVAL '5 minutes') AS online,
      (SELECT COUNT(*)::int FROM users) AS total_users,
      COALESCE((SELECT SUM(reward) FROM completed_tasks), 0)::numeric AS total_earned
  `);

  return {
    online: Number(result.rows[0]?.online || 0),
    total_users: Number(result.rows[0]?.total_users || 0),
    total_earned: Number(result.rows[0]?.total_earned || 0)
  };
}

async function completeTask({ user, taskKey, taskUrl, source, reward }) {
  await ensureUser(user);

  if (!pool) {
    const fullKey = `${user.user_id}:${taskKey}`;
    const current = memoryStore.users.get(user.user_id);

    if (memoryStore.completedTasks.has(fullKey)) {
      return { alreadyCompleted: true, profile: normalizeProfile(current, user.user_id) };
    }

    memoryStore.completedTasks.add(fullKey);
    current.balance = Number(current.balance || 0) + reward;
    current.completed = Number(current.completed || 0) + 1;
    memoryStore.users.set(user.user_id, current);

    return { alreadyCompleted: false, profile: normalizeProfile(current, user.user_id) };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const insert = await client.query(
      `
        INSERT INTO completed_tasks (telegram_id, task_key, task_url, source, reward)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (telegram_id, task_key) DO NOTHING
        RETURNING id
      `,
      [user.user_id, taskKey, taskUrl, source, reward]
    );

    if (insert.rowCount === 0) {
      const profile = await client.query(
        "SELECT balance, completed, referral_earned FROM users WHERE telegram_id = $1",
        [user.user_id]
      );
      await client.query("COMMIT");
      return { alreadyCompleted: true, profile: normalizeProfile(profile.rows[0], user.user_id) };
    }

    const updated = await client.query(
      `
        UPDATE users
        SET balance = balance + $2,
            completed = completed + 1,
            updated_at = NOW()
        WHERE telegram_id = $1
        RETURNING balance, completed, referral_earned
      `,
      [user.user_id, reward]
    );

    await client.query("COMMIT");
    return { alreadyCompleted: false, profile: normalizeProfile(updated.rows[0], user.user_id) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function normalizeWithdrawal(row) {
  return {
    id: Number(row.id),
    user_id: Number(row.telegram_id || row.user_id),
    amount: Number(row.amount || 0),
    method: row.method,
    account: row.account,
    status: row.status || "pending",
    comment: row.comment || null,
    created_at: row.created_at
  };
}

function normalizeAdminWithdrawal(row) {
  return {
    ...normalizeWithdrawal(row),
    first_name: row.first_name || null,
    username: row.username || null
  };
}

function parseWithdrawAmount(value) {
  const amount = Number(String(value).replace(",", "."));
  return Number.isFinite(amount) ? Math.floor(amount * 100) / 100 : null;
}

async function getWithdrawalRequests(userId) {
  if (!pool) {
    return memoryStore.withdrawalRequests
      .filter((request) => request.user_id === userId)
      .sort((a, b) => b.id - a.id)
      .slice(0, 20)
      .map(normalizeWithdrawal);
  }

  const result = await pool.query(
    `
      SELECT id, telegram_id, amount, method, account, status, comment, created_at
      FROM withdrawal_requests
      WHERE telegram_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `,
    [userId]
  );

  return result.rows.map(normalizeWithdrawal);
}

async function createWithdrawalRequest({ user, amount, method, account }) {
  await ensureUser(user);

  const requestAmount = parseWithdrawAmount(amount);
  const cleanMethod = String(method || "").trim().slice(0, 40);
  const cleanAccount = String(account || "").trim().slice(0, 160);

  if (!requestAmount || requestAmount < MIN_WITHDRAW_AMOUNT) {
    return { error: `Минимальная сумма вывода ${MIN_WITHDRAW_AMOUNT} ₽`, code: 400 };
  }

  if (!cleanMethod || !cleanAccount) {
    return { error: "Укажи способ вывода и реквизиты", code: 400 };
  }

  if (!pool) {
    const current = memoryStore.users.get(user.user_id);

    if (Number(current.balance || 0) < requestAmount) {
      return { error: "Недостаточно средств на балансе", code: 400 };
    }

    current.balance = Math.max(Number(current.balance || 0) - requestAmount, 0);
    current.updated_at = Date.now();

    const request = {
      id: memoryStore.nextWithdrawalId++,
      user_id: user.user_id,
      amount: requestAmount,
      method: cleanMethod,
      account: cleanAccount,
      status: "pending",
      comment: null,
      created_at: new Date().toISOString()
    };

    memoryStore.withdrawalRequests.push(request);
    memoryStore.users.set(user.user_id, current);

    return {
      request: normalizeWithdrawal(request),
      profile: normalizeProfile(current, user.user_id)
    };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const current = await client.query(
      "SELECT balance, completed, referral_earned FROM users WHERE telegram_id = $1 FOR UPDATE",
      [user.user_id]
    );

    const balance = Number(current.rows[0]?.balance || 0);

    if (balance < requestAmount) {
      await client.query("ROLLBACK");
      return { error: "Недостаточно средств на балансе", code: 400 };
    }

    const updated = await client.query(
      `
        UPDATE users
        SET balance = balance - $2,
            updated_at = NOW()
        WHERE telegram_id = $1
        RETURNING balance, completed, referral_earned
      `,
      [user.user_id, requestAmount]
    );

    const inserted = await client.query(
      `
        INSERT INTO withdrawal_requests (telegram_id, amount, method, account)
        VALUES ($1, $2, $3, $4)
        RETURNING id, telegram_id, amount, method, account, status, comment, created_at
      `,
      [user.user_id, requestAmount, cleanMethod, cleanAccount]
    );

    await client.query("COMMIT");

    return {
      request: normalizeWithdrawal(inserted.rows[0]),
      profile: normalizeProfile(updated.rows[0], user.user_id)
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function addBalance({ user, amount, reason }) {
  await ensureUser(user);

  const addAmount = parseWithdrawAmount(amount);

  if (!addAmount || addAmount <= 0) {
    return { error: "amount must be greater than 0", code: 400 };
  }

  if (!pool) {
    const current = memoryStore.users.get(user.user_id);
    current.balance = Number(current.balance || 0) + addAmount;
    current.updated_at = Date.now();
    memoryStore.users.set(user.user_id, current);
    return { profile: normalizeProfile(current, user.user_id), reason: reason || null };
  }

  const result = await pool.query(
    `
      UPDATE users
      SET balance = balance + $2,
          updated_at = NOW()
      WHERE telegram_id = $1
      RETURNING balance, completed, referral_earned
    `,
    [user.user_id, addAmount]
  );

  return { profile: normalizeProfile(result.rows[0], user.user_id), reason: reason || null };
}

async function getAdminWithdrawals(status = "pending") {
  if (!pool) {
    return memoryStore.withdrawalRequests
      .filter((request) => !status || status === "all" || request.status === status)
      .sort((a, b) => b.id - a.id)
      .slice(0, 100)
      .map((request) => {
        const user = memoryStore.users.get(request.user_id) || {};
        return normalizeAdminWithdrawal({
          ...request,
          telegram_id: request.user_id,
          first_name: user.first_name,
          username: user.username
        });
      });
  }

  const params = [];
  const where = status && status !== "all" ? "WHERE wr.status = $1" : "";

  if (where) {
    params.push(status);
  }

  const result = await pool.query(
    `
      SELECT
        wr.id, wr.telegram_id, wr.amount, wr.method, wr.account, wr.status,
        wr.comment, wr.created_at, u.first_name, u.username
      FROM withdrawal_requests wr
      JOIN users u ON u.telegram_id = wr.telegram_id
      ${where}
      ORDER BY wr.created_at DESC
      LIMIT 100
    `,
    params
  );

  return result.rows.map(normalizeAdminWithdrawal);
}

async function updateWithdrawalStatus({ id, status, comment }) {
  const allowedStatuses = new Set(["pending", "approved", "paid", "rejected"]);
  const requestId = Number(id);
  const cleanComment = String(comment || "").trim().slice(0, 300) || null;

  if (!Number.isSafeInteger(requestId) || requestId <= 0) {
    return { error: "valid withdrawal id required", code: 400 };
  }

  if (!allowedStatuses.has(status)) {
    return { error: "invalid status", code: 400 };
  }

  if (!pool) {
    const request = memoryStore.withdrawalRequests.find((item) => item.id === requestId);

    if (!request) {
      return { error: "withdrawal not found", code: 404 };
    }

    if (request.status === "rejected" && status !== "rejected") {
      return { error: "rejected withdrawal cannot be reopened", code: 400 };
    }

    if (status === "rejected" && request.status !== "rejected") {
      const user = memoryStore.users.get(request.user_id);
      user.balance = Number(user.balance || 0) + Number(request.amount || 0);
      user.updated_at = Date.now();
      memoryStore.users.set(request.user_id, user);
    }

    request.status = status;
    request.comment = cleanComment;
    request.updated_at = new Date().toISOString();

    return { request: normalizeWithdrawal(request) };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const current = await client.query(
      "SELECT id, telegram_id, amount, method, account, status, comment, created_at FROM withdrawal_requests WHERE id = $1 FOR UPDATE",
      [requestId]
    );

    const request = current.rows[0];

    if (!request) {
      await client.query("ROLLBACK");
      return { error: "withdrawal not found", code: 404 };
    }

    if (request.status === "rejected" && status !== "rejected") {
      await client.query("ROLLBACK");
      return { error: "rejected withdrawal cannot be reopened", code: 400 };
    }

    if (status === "rejected" && request.status !== "rejected") {
      await client.query(
        `
          UPDATE users
          SET balance = balance + $2,
              updated_at = NOW()
          WHERE telegram_id = $1
        `,
        [request.telegram_id, request.amount]
      );
    }

    const updated = await client.query(
      `
        UPDATE withdrawal_requests
        SET status = $2,
            comment = $3,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, telegram_id, amount, method, account, status, comment, created_at
      `,
      [requestId, status, cleanComment]
    );

    await client.query("COMMIT");
    return { request: normalizeWithdrawal(updated.rows[0]) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function buildSubgramUserPayload(source) {
  const userId = toTelegramId(source.user_id);
  const chatId = toTelegramId(source.chat_id) || userId;

  if (!userId || !chatId) {
    return null;
  }

  return {
    user_id: userId,
    chat_id: chatId,
    first_name: source.first_name || undefined,
    username: source.username || undefined,
    language_code: source.language_code || "ru",
    is_premium: source.is_premium === "true" || source.is_premium === true,
    action: SUBGRAM_ACTION,
    max_sponsors: SUBGRAM_MAX_SPONSORS,
    get_links: 1
  };
}

async function requestSubgram(endpoint, payload) {
  if (!SUBGRAM_API_KEY) {
    return { status: "error", code: "missing_key", message: "SUBGRAM_API_KEY не указан в .env" };
  }

  const response = await fetch(`${SUBGRAM_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Auth: SUBGRAM_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      status: "error",
      code: response.status,
      message: data.message || "SubGram API вернул ошибку",
      raw: data
    };
  }

  return data;
}

function getSponsorsFromResponse(data) {
  return data?.additional?.sponsors
    || data?.result?.sponsors
    || data?.response?.sponsors
    || data?.sponsors
    || [];
}

function normalizeSponsorTask(sponsor, index) {
  const link = sponsor.link || sponsor.url;
  const id = String(sponsor.ads_id || sponsor.resource_id || link || `subgram_${index}`);
  const title = sponsor.button_text || sponsor.title || "Подпишись на канал партнёра";
  const status = sponsor.status || "unsubscribed";

  return {
    id,
    title,
    reward: SUBGRAM_REWARD,
    type: sponsor.type || "subscribe",
    url: link,
    status,
    source: "subgram",
    available: sponsor.available_now !== false && status !== "subscribed"
  };
}

function makeDemoTasks() {
  return [
    {
      id: "demo_1",
      title: "Подпишись на Telegram-канал",
      reward: SUBGRAM_REWARD,
      type: "subscribe",
      url: "https://t.me/telegram",
      status: "available",
      source: "demo",
      available: true
    },
    {
      id: "demo_2",
      title: "Вступи в канал партнёра",
      reward: SUBGRAM_REWARD,
      type: "subscribe",
      url: "https://t.me/durov",
      status: "available",
      source: "demo",
      available: true
    }
  ];
}

bot?.start(async (ctx) => {
  const name = ctx.from?.first_name || "друг";

  await ctx.reply(
`Привет, ${name}!

Здесь можно зарабатывать на простых заданиях:
- подписки на Telegram-каналы
- быстрые проверки
- бонусы за друзей

Нажми кнопку ниже, чтобы открыть приложение.`,
    Markup.inlineKeyboard([
      Markup.button.webApp("Заработать", WEBAPP_URL)
    ])
  );
});

bot?.command("app", async (ctx) => {
  await ctx.reply(
    "Открыть приложение",
    Markup.inlineKeyboard([
      Markup.button.webApp("Открыть Mini App", WEBAPP_URL)
    ])
  );
});

app.get("/health", (req, res) => {
  res.json({ ok: true, subgram: Boolean(SUBGRAM_API_KEY), database: Boolean(pool) });
});

app.get("/api/profile", async (req, res) => {
  const user = makeUserFromSource(req.query);

  if (!user) {
    return res.status(400).json({ error: "valid user_id required" });
  }

  try {
    res.json(await getProfile(user));
  } catch (error) {
    res.status(500).json({ error: "Не удалось загрузить профиль", details: error.message });
  }
});

app.get("/api/withdrawals", async (req, res) => {
  const user = makeUserFromSource(req.query);

  if (!user) {
    return res.status(400).json({ error: "valid user_id required" });
  }

  try {
    await ensureUser(user);
    res.json({ requests: await getWithdrawalRequests(user.user_id) });
  } catch (error) {
    res.status(500).json({ error: "Не удалось загрузить заявки", details: error.message });
  }
});

app.post("/api/withdrawals", async (req, res) => {
  const user = makeUserFromSource(req.body);

  if (!user) {
    return res.status(400).json({ error: "valid user_id required" });
  }

  try {
    const result = await createWithdrawalRequest({
      user,
      amount: req.body.amount,
      method: req.body.method,
      account: req.body.account
    });

    if (result.error) {
      return res.status(result.code || 400).json({ error: result.error });
    }

    res.json({
      ok: true,
      message: "Заявка на вывод создана",
      request: result.request,
      profile: result.profile
    });
  } catch (error) {
    res.status(500).json({ error: "Не удалось создать заявку", details: error.message });
  }
});

app.get("/api/admin/withdrawals", requireAdmin, async (req, res) => {
  try {
    res.json({ requests: await getAdminWithdrawals(String(req.query.status || "pending")) });
  } catch (error) {
    res.status(500).json({ error: "Не удалось загрузить заявки", details: error.message });
  }
});

app.post("/api/admin/withdrawals/:id/status", requireAdmin, async (req, res) => {
  try {
    const result = await updateWithdrawalStatus({
      id: req.params.id,
      status: String(req.body.status || ""),
      comment: req.body.comment
    });

    if (result.error) {
      return res.status(result.code || 400).json({ error: result.error });
    }

    res.json({ ok: true, request: result.request });
  } catch (error) {
    res.status(500).json({ error: "Не удалось обновить заявку", details: error.message });
  }
});

app.post("/api/admin/balance", requireAdmin, async (req, res) => {
  const user = makeUserFromSource(req.body);

  if (!user) {
    return res.status(400).json({ error: "valid user_id required" });
  }

  try {
    const result = await addBalance({
      user,
      amount: req.body.amount,
      reason: req.body.reason
    });

    if (result.error) {
      return res.status(result.code || 400).json({ error: result.error });
    }

    res.json({ ok: true, profile: result.profile });
  } catch (error) {
    res.status(500).json({ error: "Не удалось начислить баланс", details: error.message });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    res.json(await getServiceStats());
  } catch (error) {
    res.status(500).json({ error: "Не удалось загрузить статистику", details: error.message });
  }
});

app.get("/api/tasks", async (req, res) => {
  const user = makeUserFromSource(req.query);
  const payload = buildSubgramUserPayload(req.query);

  if (!user || !payload) {
    return res.status(400).json({ error: "valid user_id required" });
  }

  try {
    await ensureUser(user);
    const completedKeys = await getCompletedTaskKeys(user.user_id);

    if (!SUBGRAM_API_KEY) {
      return res.json({
        source: "demo",
        warning: "SUBGRAM_API_KEY не указан в .env",
        tasks: makeDemoTasks().filter((task) => !completedKeys.has(task.id))
      });
    }

    const data = await requestSubgram("/get-sponsors", payload);

    if (data.status === "error") {
      return res.status(data.code === 401 ? 401 : 502).json({
        error: data.message || "SubGram API error",
        tasks: []
      });
    }

    const tasks = getSponsorsFromResponse(data)
      .map(normalizeSponsorTask)
      .filter((task) => task.url && task.available && !completedKeys.has(task.id));

    res.json({
      source: "subgram",
      status: data.status,
      message: data.message,
      tasks
    });
  } catch (error) {
    res.status(502).json({
      error: "Не удалось получить задания SubGram",
      details: error.message,
      tasks: []
    });
  }
});

app.post("/api/check-task", async (req, res) => {
  const { user_id, chat_id, task_id, task_url, source } = req.body;
  const user = makeUserFromSource({ user_id });
  const userId = user?.user_id;
  const taskKey = String(task_id || task_url || "");

  if (!userId || !taskKey || !task_url) {
    return res.status(400).json({ error: "valid user_id, task_id and task_url required" });
  }

  if (!SUBGRAM_API_KEY) {
    const completion = await completeTask({
      user,
      taskKey,
      taskUrl: task_url,
      source: source || "demo",
      reward: SUBGRAM_REWARD
    });

    return res.json({
      ok: !completion.alreadyCompleted,
      alreadyCompleted: completion.alreadyCompleted,
      message: completion.alreadyCompleted
        ? "Это задание уже было оплачено"
        : "Демо-проверка выполнена",
      reward: completion.alreadyCompleted ? 0 : SUBGRAM_REWARD,
      profile: completion.profile
    });
  }

  try {
    const data = await requestSubgram("/get-user-subscriptions", {
      user_id: userId,
      chat_id: toTelegramId(chat_id) || userId,
      links: [task_url]
    });

    if (data.status === "error") {
      if (Number(data.code) === 404) {
        return res.json({
          ok: false,
          status: "unsubscribed",
          message: "Подписка пока не найдена",
          reward: 0
        });
      }

      return res.status(data.code === 401 ? 401 : 502).json({
        ok: false,
        message: data.message || "SubGram API error"
      });
    }

    const subscriptions = data.result || data.response || data.subscriptions || data.data || [];
    const checks = Array.isArray(subscriptions) ? subscriptions : [subscriptions];
    const match = checks.find((item) => item?.link === task_url) || checks[0] || data;
    const status = match.status || data.status;
    const subscribed = status === "subscribed" || status === "notgetted";

    if (!subscribed) {
      return res.json({
        ok: false,
        status,
        message: "Подписка пока не найдена",
        reward: 0
      });
    }

    const completion = await completeTask({
      user,
      taskKey,
      taskUrl: task_url,
      source: source || "subgram",
      reward: SUBGRAM_REWARD
    });

    res.json({
      ok: !completion.alreadyCompleted,
      alreadyCompleted: completion.alreadyCompleted,
      status,
      message: completion.alreadyCompleted
        ? "Эта подписка уже была оплачена"
        : "Подписка подтверждена",
      reward: completion.alreadyCompleted ? 0 : SUBGRAM_REWARD,
      profile: completion.profile
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: "Не удалось проверить подписку SubGram",
      details: error.message
    });
  }
});

async function start() {
  await initDatabase();

  app.listen(PORT, () => {
    console.log(`Web server started on port ${PORT}`);
  });

  if (bot) {
    bot.launch(() => {
      console.log("Telegram bot started");
    });
  } else {
    console.log("Telegram bot polling disabled");
  }
}

start().catch((error) => {
  console.error("Startup failed", error);
  process.exit(1);
});

process.once("SIGINT", () => bot?.stop("SIGINT"));
process.once("SIGTERM", () => bot?.stop("SIGTERM"));
