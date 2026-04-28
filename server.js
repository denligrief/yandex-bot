import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
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

const SUBGRAM_API_KEY = process.env.SUBGRAM_API_KEY;
const SUBGRAM_API_BASE = process.env.SUBGRAM_API_BASE || "https://api.subgram.org";
const SUBGRAM_ACTION = process.env.SUBGRAM_ACTION || "task";
const SUBGRAM_MAX_SPONSORS = Number(process.env.SUBGRAM_MAX_SPONSORS || 10);
const SUBGRAM_REWARD = Number(process.env.SUBGRAM_REWARD || 0.25);

const CPX_APP_ID = process.env.CPX_APP_ID || "";
const CPX_SECURE_HASH = process.env.CPX_SECURE_HASH || "";
const CPX_FRAME_BASE = process.env.CPX_FRAME_BASE || "https://offers.cpx-research.com/index.php";

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
  cpxTransactions: new Map()
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
    CREATE TABLE IF NOT EXISTS cpx_transactions (
      trans_id TEXT PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      status INTEGER NOT NULL,
      type TEXT,
      amount_local NUMERIC(12, 2) NOT NULL DEFAULT 0,
      amount_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
      subid_1 TEXT,
      subid_2 TEXT,
      ip_click TEXT,
      credited BOOLEAN NOT NULL DEFAULT FALSE,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
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

function normalizeCpxPayload(req) {
  return {
    status: String(req.query.status || req.body?.status || ""),
    trans_id: String(req.query.trans_id || req.body?.trans_id || ""),
    user_id: String(req.query.user_id || req.body?.user_id || ""),
    subid_1: String(req.query.subid_1 || req.body?.subid_1 || ""),
    subid_2: String(req.query.subid_2 || req.body?.subid_2 || ""),
    amount_local: String(req.query.amount_local || req.body?.amount_local || "0"),
    amount_usd: String(req.query.amount_usd || req.body?.amount_usd || "0"),
    ip_click: String(req.query.ip_click || req.body?.ip_click || ""),
    type: String(req.query.type || req.body?.type || ""),
    secure_hash: String(req.query.secure_hash || req.body?.secure_hash || req.query.hash || req.body?.hash || "")
  };
}

function validateCpxPostback(payload) {
  if (!CPX_SECURE_HASH) {
    return true;
  }

  const expected = crypto
    .createHash("md5")
    .update(`${payload.trans_id}-${CPX_SECURE_HASH}`)
    .digest("hex");

  return payload.secure_hash.toLowerCase() === expected;
}

function parseMoney(value) {
  const amount = Number(String(value).replace(",", "."));
  return Number.isFinite(amount) ? amount : null;
}

async function processCpxPostback(payload) {
  const userId = toTelegramId(payload.user_id);
  const status = Number(payload.status);
  const amountLocal = parseMoney(payload.amount_local);
  const amountUsd = parseMoney(payload.amount_usd) || 0;

  if (!payload.trans_id || !userId || ![1, 2].includes(status) || amountLocal === null) {
    return { ok: false, code: 400, message: "invalid CPX payload" };
  }

  if (!validateCpxPostback(payload)) {
    return { ok: false, code: 403, message: "invalid secure_hash" };
  }

  const user = { user_id: userId, first_name: null, username: null };
  await ensureUser(user);

  if (!pool) {
    const currentTx = memoryStore.cpxTransactions.get(payload.trans_id);
    const currentUser = memoryStore.users.get(userId);
    let balanceDelta = 0;
    let completedDelta = 0;

    if (status === 1 && !currentTx?.credited) {
      balanceDelta = amountLocal;
      completedDelta = 1;
    }

    if (status === 2 && currentTx?.credited) {
      balanceDelta = -Number(currentTx.amount_local || amountLocal);
      completedDelta = -1;
    }

    currentUser.balance = Math.max(Number(currentUser.balance || 0) + balanceDelta, 0);
    currentUser.completed = Math.max(Number(currentUser.completed || 0) + completedDelta, 0);
    currentUser.updated_at = Date.now();

    memoryStore.users.set(userId, currentUser);
    memoryStore.cpxTransactions.set(payload.trans_id, {
      ...payload,
      user_id: userId,
      status,
      amount_local: amountLocal,
      amount_usd: amountUsd,
      credited: status === 1
    });

    return { ok: true, credited: status === 1 && balanceDelta > 0, reversed: status === 2 && balanceDelta < 0 };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT status, amount_local, credited FROM cpx_transactions WHERE trans_id = $1 FOR UPDATE",
      [payload.trans_id]
    );

    const row = existing.rows[0];
    let balanceDelta = 0;
    let completedDelta = 0;
    let credited = row?.credited || false;

    if (status === 1 && !credited) {
      balanceDelta = amountLocal;
      completedDelta = 1;
      credited = true;
    }

    if (status === 2 && credited) {
      balanceDelta = -Number(row?.amount_local || amountLocal);
      completedDelta = -1;
      credited = false;
    }

    await client.query(
      `
        INSERT INTO cpx_transactions (
          trans_id, telegram_id, status, type, amount_local, amount_usd,
          subid_1, subid_2, ip_click, credited, raw_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (trans_id) DO UPDATE SET
          status = EXCLUDED.status,
          type = EXCLUDED.type,
          amount_usd = EXCLUDED.amount_usd,
          subid_1 = EXCLUDED.subid_1,
          subid_2 = EXCLUDED.subid_2,
          ip_click = EXCLUDED.ip_click,
          credited = EXCLUDED.credited,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        payload.trans_id,
        userId,
        status,
        payload.type,
        amountLocal,
        amountUsd,
        payload.subid_1,
        payload.subid_2,
        payload.ip_click,
        credited,
        JSON.stringify(payload)
      ]
    );

    if (balanceDelta !== 0 || completedDelta !== 0) {
      await client.query(
        `
          UPDATE users
          SET balance = GREATEST(balance + $2, 0),
              completed = GREATEST(completed + $3, 0),
              updated_at = NOW()
          WHERE telegram_id = $1
        `,
        [userId, balanceDelta, completedDelta]
      );
    }

    await client.query("COMMIT");
    return { ok: true, credited: status === 1 && balanceDelta > 0, reversed: status === 2 && balanceDelta < 0 };
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

function buildCpxFrameUrl(source) {
  if (!CPX_APP_ID) {
    return null;
  }

  const user = makeUserFromSource(source);

  if (!user) {
    return null;
  }

  const extUserId = String(user.user_id);
  const params = new URLSearchParams({
    app_id: CPX_APP_ID,
    ext_user_id: extUserId,
    username: user.username || user.first_name || `user_${extUserId}`,
    email: "",
    subid_1: "telegram",
    subid_2: ""
  });

  if (CPX_SECURE_HASH) {
    params.set(
      "secure_hash",
      crypto.createHash("md5").update(`${extUserId}-${CPX_SECURE_HASH}`).digest("hex")
    );
  }

  return `${CPX_FRAME_BASE}?${params.toString()}`;
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

app.get("/api/stats", async (req, res) => {
  try {
    res.json(await getServiceStats());
  } catch (error) {
    res.status(500).json({ error: "Не удалось загрузить статистику", details: error.message });
  }
});

app.get("/api/cpx-frame", async (req, res) => {
  const user = makeUserFromSource(req.query);
  const frameUrl = buildCpxFrameUrl(req.query);

  if (!user) {
    return res.status(400).json({ error: "valid user_id required" });
  }

  if (!frameUrl) {
    return res.status(503).json({ error: "CPX_APP_ID is not configured" });
  }

  try {
    await ensureUser(user);
    res.json({ url: frameUrl });
  } catch (error) {
    res.status(500).json({ error: "Не удалось открыть опросы", details: error.message });
  }
});

app.all("/api/cpx-postback", async (req, res) => {
  const payload = normalizeCpxPayload(req);

  try {
    const result = await processCpxPostback(payload);

    if (!result.ok) {
      return res.status(result.code || 400).send(result.message || "error");
    }

    res.send("OK");
  } catch (error) {
    console.error("CPX postback failed", error);
    res.status(500).send("error");
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
