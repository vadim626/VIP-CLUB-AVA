/**
 * AVA TRADE — сервер проверки Pocket Option ID
 * ------------------------------------------------------------
 * Работает на Cloudflare Workers (бесплатный тариф).
 *
 * Как это устроено:
 *  1. Посетитель вводит ID на сайте  → POST /api/submit
 *  2. Сервер присылает администратору сообщение в Telegram
 *     с кнопками «✅ Одобрить» / «❌ Отклонить».
 *  3. Администратор проверяет ID в PocketPartners Bot сам
 *     и нажимает кнопку                → POST /telegram/webhook
 *  4. При одобрении сервер создаёт ОДНОРАЗОВУЮ ссылку
 *     в закрытый канал (вступить может только 1 человек).
 *  5. Сайт спрашивает статус           → GET /api/status
 *     и показывает кнопку входа в канал.
 *
 * Никаких автоматических «успешных проверок» здесь нет:
 * доступ открывается ТОЛЬКО после нажатия кнопки администратором.
 *
 * Секреты хранятся в настройках Cloudflare (не в коде):
 *   BOT_TOKEN       — токен вашего бота от @BotFather
 *   WEBHOOK_SECRET  — ваш секретный пароль настройки (латиница и цифры)
 * Остальное сервер настраивает сам и хранит в KV:
 *   администратор   — тот, кто отправит боту «/admin ПАРОЛЬ»
 *   канал           — канал, который администратор подтвердит кнопкой
 *   (можно задать и вручную переменными ADMIN_CHAT_ID и CHANNEL_ID)
 * Открыть /setup?key=ПАРОЛЬ — подключает бота и показывает, что осталось.
 * Хранилище: KV-пространство с именем привязки AVA_KV.
 */

const REQUEST_TTL = 60 * 60 * 24 * 60; // заявки хранятся 60 дней
const RATE_LIMIT_MAX = 5;               // не больше 5 заявок…
const RATE_LIMIT_WINDOW = 60 * 60;      // …в час с одного IP
const ID_PATTERN = /^\d{5,12}$/;        // Pocket Option ID — только цифры
const INVITE_TTL = 60 * 60 * 24 * 7;    // одноразовая ссылка действует 7 дней

export default {
  async fetch(request, rawEnv) {
    const url = new URL(request.url);
    const env = await withConfig(rawEnv);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, configured: isConfigured(env) }, 200, cors);
      }
      if (url.pathname === "/api/submit" && request.method === "POST") {
        return await handleSubmit(request, env, cors);
      }
      if (url.pathname === "/api/status" && request.method === "GET") {
        return await handleStatus(request, env, cors);
      }
      if (url.pathname === "/api/academy" && request.method === "GET") {
        return await handleAcademy(request, env, cors);
      }
      if (url.pathname === "/setup" && request.method === "GET") {
        return await handleSetup(url, env);
      }
      if (url.pathname === "/telegram/webhook" && request.method === "POST") {
        return await handleWebhook(request, env);
      }
      return json({ error: "not_found" }, 404, cors);
    } catch (err) {
      console.error("Unhandled error", err && err.stack ? err.stack : err);
      return json({ error: "server_error" }, 500, cors);
    }
  },
};

/* ============================================================
   САЙТ → СЕРВЕР
   ============================================================ */

async function handleSubmit(request, env, cors) {
  if (!isConfigured(env)) {
    return json({ error: "not_configured" }, 503, cors);
  }
  if (!isAllowedOrigin(request, env)) {
    return json({ error: "forbidden_origin" }, 403, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400, cors);
  }

  const pocketId = String((body && body.pocketId) || "").trim();
  if (!ID_PATTERN.test(pocketId)) {
    return json({ error: "invalid_id" }, 400, cors);
  }

  // Ограничение частоты: защищает вас от спама заявками.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = "rl:" + (await sha256(ip));
  const used = parseInt((await env.AVA_KV.get(ipKey)) || "0", 10);
  if (used >= RATE_LIMIT_MAX) {
    return json({ error: "rate_limited" }, 429, cors);
  }
  await env.AVA_KV.put(ipKey, String(used + 1), { expirationTtl: RATE_LIMIT_WINDOW });

  // Был ли этот ID уже раньше? Сообщим администратору, решать ему.
  const previousReqId = await env.AVA_KV.get("pid:" + pocketId);
  let previous = null;
  if (previousReqId) {
    previous = await getRequest(env, previousReqId);
  }

  const reqId = randomHex(8);   // короткий номер заявки (виден админу)
  const token = randomHex(32);  // секретный ключ посетителя (только у него)
  const record = {
    reqId,
    pocketId,
    tokenHash: await sha256(token),
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  const text = adminMessageText(record, previous);
  const sent = await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_CHAT_ID,
    text,
    parse_mode: "HTML",
    reply_markup: pendingKeyboard(reqId),
  });

  if (!sent.ok) {
    console.error("sendMessage failed", sent.description);
    return json({ error: "telegram_unavailable" }, 502, cors);
  }

  record.adminMessageId = sent.result.message_id;
  await saveRequest(env, record);
  await env.AVA_KV.put("tok:" + record.tokenHash, reqId, { expirationTtl: REQUEST_TTL });
  await env.AVA_KV.put("pid:" + pocketId, reqId, { expirationTtl: REQUEST_TTL });

  return json({ token, status: "pending", pocketId }, 200, cors);
}

// Находит заявку по секретному ключу посетителя.
async function findByToken(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!/^[0-9a-f]{64}$/.test(token)) return { error: "unauthorized", code: 401 };
  const reqId = await env.AVA_KV.get("tok:" + (await sha256(token)));
  const record = reqId ? await getRequest(env, reqId) : null;
  if (!record) return { error: "not_found", code: 404 };
  return { record };
}

// Уроки академии выдаются ТОЛЬКО одобренным участникам.
async function handleAcademy(request, env, cors) {
  const found = await findByToken(request, env);
  if (found.error) return json({ error: found.error }, found.code, cors);
  if (found.record.status !== "approved") return json({ error: "not_approved" }, 403, cors);
  return json({ lessons: academyLessons() }, 200, cors);
}

async function handleStatus(request, env, cors) {
  const found = await findByToken(request, env);
  if (found.error) return json({ error: found.error }, found.code, cors);
  const record = found.record;

  // Если одобренный человек вернулся после истечения ссылки —
  // выдаём ему новую одноразовую ссылку (старая уже не работает).
  if (record.status === "approved" && record.inviteExpiresAt && nowSec() > record.inviteExpiresAt) {
    const link = await createInvite(env, record.pocketId);
    if (link.ok) {
      record.inviteLink = link.result.invite_link;
      record.inviteExpiresAt = link.expiresAt;
      await saveRequest(env, record);
    } else {
      console.error("re-createChatInviteLink failed", link.description);
      record.inviteLink = null;
    }
  }

  const out = { status: record.status, pocketId: record.pocketId };
  if (record.status === "approved" && record.inviteLink) {
    out.inviteLink = record.inviteLink;
    out.inviteExpiresAt = record.inviteExpiresAt || null;
  }
  return json(out, 200, cors);
}

/* ============================================================
   TELEGRAM → СЕРВЕР (нажатия кнопок администратором)
   ============================================================ */

async function handleWebhook(request, env) {
  // Telegram присылает секрет в заголовке — чужие запросы отклоняем.
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!env.WEBHOOK_SECRET || !timingSafeEqual(secret, env.WEBHOOK_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok");
  }

  const msg = update.message;
  if (msg && msg.chat && msg.chat.type === "private" && msg.text) {
    await handlePrivateMessage(env, msg);
    return new Response("ok");
  }

  // Бот увидел канал (его добавили админом или в канале новый пост)
  const channelChat =
    (update.channel_post && update.channel_post.chat) ||
    (update.my_chat_member && update.my_chat_member.chat.type === "channel" && update.my_chat_member.chat);
  if (channelChat && channelChat.type === "channel") {
    await offerChannel(env, channelChat);
    return new Response("ok");
  }

  const cb = update.callback_query;
  if (!cb) return new Response("ok");

  // Подтверждение канала администратором
  const chMatch = /^c:(-\d{5,20})$/.exec(cb.data || "");
  if (chMatch) {
    if (!env.ADMIN_CHAT_ID || String(cb.from.id) !== String(env.ADMIN_CHAT_ID)) {
      await answer(env, cb.id, "Нет доступа");
      return new Response("ok");
    }
    await env.AVA_KV.put("cfg:channel", chMatch[1]);
    await telegram(env, "editMessageText", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: "✅ Канал подключён. Теперь при одобрении заявок бот будет выдавать одноразовые ссылки в этот канал.",
    });
    await answer(env, cb.id, "Канал подключён ✅");
    return new Response("ok");
  }

  // Нажимать кнопки может только администратор.
  if (String(cb.from.id) !== String(env.ADMIN_CHAT_ID)) {
    await answer(env, cb.id, "Нет доступа");
    return new Response("ok");
  }

  const match = /^(a|r):([0-9a-f]{16})$/.exec(cb.data || "");
  if (!match) {
    await answer(env, cb.id, "Неизвестная команда");
    return new Response("ok");
  }

  const action = match[1];
  const record = await getRequest(env, match[2]);
  if (!record) {
    await answer(env, cb.id, "Заявка не найдена или устарела");
    return new Response("ok");
  }
  if (record.status !== "pending") {
    await answer(env, cb.id, "Заявка уже обработана");
    return new Response("ok");
  }

  if (action === "a") {
    // Одноразовая ссылка: по ней сможет вступить только 1 человек.
    const link = await createInvite(env, record.pocketId);
    if (!link.ok) {
      console.error("createChatInviteLink failed", link.description);
      await answer(
        env,
        cb.id,
        "Не удалось создать ссылку. Бот должен быть администратором канала с правом приглашать.",
        true,
      );
      return new Response("ok");
    }
    record.status = "approved";
    record.inviteLink = link.result.invite_link;
    record.inviteExpiresAt = link.expiresAt;
  } else {
    record.status = "rejected";
  }

  record.decidedAt = new Date().toISOString();
  await saveRequest(env, record);

  await telegram(env, "editMessageText", {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    text: adminMessageText(record, null),
    parse_mode: "HTML",
  });
  await answer(env, cb.id, record.status === "approved" ? "Одобрено ✅" : "Отклонено ❌");
  return new Response("ok");
}

/* ============================================================
   ВСПОМОГАТЕЛЬНОЕ
   ============================================================ */

function adminMessageText(record, previous) {
  const lines = [
    "<b>Новая заявка AVA TRADE</b>",
    "",
    "Pocket Option ID: <code>" + record.pocketId + "</code>",
    "Заявка: #" + record.reqId,
    "Время: " + record.createdAt.replace("T", " ").slice(0, 16) + " UTC",
  ];
  if (previous) {
    lines.push("", "⚠️ Этот ID уже подавали раньше (статус: " + statusRu(previous.status) + ").");
  }
  if (record.status === "pending") {
    lines.push("", "Проверьте ID в PocketPartners Bot и нажмите кнопку.");
  } else {
    lines[0] = "<b>Заявка AVA TRADE</b>";
    lines.push("", "Решение: " + statusRu(record.status));
  }
  return lines.join("\n");
}

function statusRu(status) {
  return { pending: "ожидает ⏳", approved: "одобрено ✅", rejected: "отклонено ❌" }[status] || status;
}

function pendingKeyboard(reqId) {
  return {
    inline_keyboard: [[
      { text: "✅ Одобрить", callback_data: "a:" + reqId },
      { text: "❌ Отклонить", callback_data: "r:" + reqId },
    ]],
  };
}

async function telegram(env, method, payload) {
  try {
    const res = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, description: String(err) };
  }
}

// Персональная ссылка: вступить может 1 человек, срок — 7 дней.
async function createInvite(env, pocketId) {
  const expiresAt = nowSec() + INVITE_TTL;
  const res = await telegram(env, "createChatInviteLink", {
    chat_id: env.CHANNEL_ID,
    name: ("ID " + pocketId).slice(0, 32),
    member_limit: 1,
    expire_date: expiresAt,
  });
  res.expiresAt = expiresAt;
  return res;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function answer(env, callbackId, text, alert = false) {
  return telegram(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: alert,
  });
}

async function getRequest(env, reqId) {
  const raw = await env.AVA_KV.get("req:" + reqId);
  return raw ? JSON.parse(raw) : null;
}

function saveRequest(env, record) {
  return env.AVA_KV.put("req:" + record.reqId, JSON.stringify(record), {
    expirationTtl: REQUEST_TTL,
  });
}

/* ---------- Автонастройка ---------- */

// Подмешивает к настройкам администратора и канал, сохранённые в KV.
async function withConfig(env) {
  if (!env || !env.AVA_KV) return env || {};
  const out = { ...env };
  if (!out.ADMIN_CHAT_ID) out.ADMIN_CHAT_ID = (await env.AVA_KV.get("cfg:admin")) || undefined;
  if (!out.CHANNEL_ID) out.CHANNEL_ID = (await env.AVA_KV.get("cfg:channel")) || undefined;
  return out;
}

async function handlePrivateMessage(env, msg) {
  const text = msg.text.trim();
  const reply = (t) => telegram(env, "sendMessage", { chat_id: msg.chat.id, text: t });

  const adminCmd = /^\/admin\s+(\S+)$/.exec(text);
  if (adminCmd) {
    if (!env.WEBHOOK_SECRET || !timingSafeEqual(adminCmd[1], env.WEBHOOK_SECRET)) {
      await reply("Неверный пароль.");
      return;
    }
    await env.AVA_KV.put("cfg:admin", String(msg.from.id));
    await reply(
      "✅ Вы назначены администратором AVA TRADE.\n\n" +
      (env.CHANNEL_ID
        ? "Канал уже подключён — всё готово. Заявки с сайта будут приходить сюда."
        : "Последний шаг: опубликуйте любое сообщение в вашем закрытом канале (потом его можно удалить). Я пришлю кнопку, чтобы подтвердить канал."),
    );
    return;
  }

  if (String(msg.from.id) === String(env.ADMIN_CHAT_ID)) {
    await reply(
      "AVA TRADE бот работает ✅\n" +
      "Канал: " + (env.CHANNEL_ID ? "подключён" : "не подключён — опубликуйте сообщение в канале") + "\n" +
      "Заявки с сайта приходят сюда с кнопками ✅ / ❌.",
    );
  } else {
    await reply("Это служебный бот AVA TRADE. Вступить в клуб можно через сайт.");
  }
}

async function offerChannel(env, chat) {
  if (!env.ADMIN_CHAT_ID || String(env.CHANNEL_ID) === String(chat.id)) return;
  const seenKey = "cfg:offered:" + chat.id;
  if (await env.AVA_KV.get(seenKey)) return; // не спамим повторно
  await env.AVA_KV.put(seenKey, "1", { expirationTtl: 600 });
  await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_CHAT_ID,
    text:
      "Бот видит канал «" + (chat.title || "без названия") + "».\n" +
      (env.CHANNEL_ID ? "Сейчас подключён другой канал. Заменить на этот?" : "Это ваш закрытый VIP-канал?"),
    reply_markup: { inline_keyboard: [[{ text: "✅ Да, это мой канал", callback_data: "c:" + chat.id }]] },
  });
}

async function handleSetup(url, env) {
  const key = url.searchParams.get("key") || "";
  const page = (title, rows) =>
    new Response(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
        "<title>AVA TRADE — настройка</title><body style='font:17px -apple-system,system-ui,sans-serif;background:#0b0714;color:#fff;padding:24px;max-width:560px;margin:auto;line-height:1.5'>" +
        "<h2>" + title + "</h2>" + rows.map((r) => "<p>" + r + "</p>").join("") + "</body>",
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
    );

  if (!env.WEBHOOK_SECRET || !env.BOT_TOKEN) {
    return page("Настройка AVA TRADE", [
      (env.BOT_TOKEN ? "✅" : "❌") + " BOT_TOKEN",
      (env.WEBHOOK_SECRET ? "✅" : "❌") + " WEBHOOK_SECRET",
      (env.AVA_KV ? "✅" : "❌") + " Хранилище AVA_KV",
      "Добавьте недостающее в Cloudflare → Settings → Variables and Secrets.",
    ]);
  }
  if (!timingSafeEqual(key, env.WEBHOOK_SECRET)) {
    return page("Нет доступа", ["Неверный пароль в адресе (?key=…)."]);
  }

  const hook = await telegram(env, "setWebhook", {
    url: url.origin + "/telegram/webhook",
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "channel_post", "my_chat_member"],
  });
  const me = await telegram(env, "getMe", {});
  const bot = me.ok ? "@" + me.result.username : "";

  return page("Настройка AVA TRADE", [
    (me.ok ? "✅ Бот " + bot : "❌ Бот не отвечает — проверьте BOT_TOKEN"),
    (hook.ok ? "✅ Бот подключён к серверу" : "❌ Не удалось подключить бота: " + (hook.description || "")),
    (env.AVA_KV ? "✅ Хранилище заявок" : "❌ Хранилище AVA_KV не подключено"),
    (env.ADMIN_CHAT_ID ? "✅ Администратор назначен" : "⏳ Администратор: отправьте боту " + bot + " сообщение <b>/admin ВАШ_ПАРОЛЬ</b>"),
    (env.CHANNEL_ID ? "✅ Канал подключён" : "⏳ Канал: опубликуйте любое сообщение в закрытом канале и нажмите кнопку, которую пришлёт бот"),
    isConfigured(env) ? "<b>🎉 Всё готово! Сайт принимает заявки.</b>" : "Обновите эту страницу после каждого шага.",
  ]);
}

function isConfigured(env) {
  return Boolean(
    env.BOT_TOKEN && env.ADMIN_CHAT_ID && env.CHANNEL_ID && env.WEBHOOK_SECRET && env.AVA_KV,
  );
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

// Поддерживает шаблоны со звёздочкой, например https://vip-club-ava-*.vercel.app
// (тестовые версии сайта на Vercel).
function originMatches(origin, list) {
  return list.some((entry) => {
    if (!entry.includes("*")) return entry === origin;
    const re = new RegExp("^" + entry.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]+") + "$");
    return re.test(origin);
  });
}

function isAllowedOrigin(request, env) {
  const list = allowedOrigins(env);
  if (list.length === 0) return true; // не настроено — пускаем (удобно для теста)
  return originMatches(request.headers.get("Origin") || "", list);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const list = allowedOrigins(env);
  const allow = list.length === 0 ? "*" : originMatches(origin, list) ? origin : list[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ============================================================
   TRADING ACADEMY — уроки
   ------------------------------------------------------------
   Уроки отдаются только одобренным участникам (/api/academy).
   Графики не картинки: сервер отдаёт данные свечей, а сайт
   рисует их сам в стиле торгового терминала.
   ============================================================ */

function rng(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const K = (o, h, l, c) => [r5(o), r5(h), r5(l), r5(c)];
const lastClose = (cs) => cs[cs.length - 1][3];

// Случайное, но всегда одинаковое движение цены (seed фиксирован).
function walk(seed, n, start, drift, vol) {
  const r = rng(seed);
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o + drift + (r() - 0.5) * 2 * vol;
    out.push(K(o, Math.max(o, c) + r() * vol * 0.7, Math.min(o, c) - r() * vol * 0.7, c));
    p = c;
  }
  return out;
}

// Боковик: цена ходит между поддержкой и сопротивлением.
function range(seed, n, mid, amp, vol) {
  const r = rng(seed);
  const out = [];
  let p = mid;
  for (let i = 0; i < n; i++) {
    const target = mid + amp * Math.sin(i * 0.42) + (r() - 0.5) * vol * 0.6;
    const o = p;
    const c = target;
    const top = mid + amp * 1.08;
    const bot = mid - amp * 1.08;
    const h = Math.min(Math.max(o, c) + r() * vol * 0.6, top);
    const l = Math.max(Math.min(o, c) - r() * vol * 0.6, bot);
    out.push(K(o, Math.max(h, o, c), Math.min(l, o, c), c));
    p = c;
  }
  return out;
}

// Линия поддержки тренда: проходит через минимумы снизу.
function supportLine(cs, from, to) {
  let i1 = from;
  for (let i = from; i < from + 8; i++) if (cs[i][2] < cs[i1][2]) i1 = i;
  let slope = Infinity, i2 = i1 + 1;
  for (let j = i1 + 6; j <= to; j++) {
    const s = (cs[j][2] - cs[i1][2]) / (j - i1);
    if (s < slope) { slope = s; i2 = j; }
  }
  return { i1, p1: cs[i1][2], i2: to, p2: r5(cs[i1][2] + slope * (to - i1)) };
}

function academyLessons() {
  const V = 0.00045;

  // Урок 1 — сделка на платформе
  const l1 = walk(11, 34, 1.0842, 0.00004, V);
  l1.push(...walk(12, 8, lastClose(l1), 0.00022, V * 0.8));

  // Урок 3 — паттерны
  const hammer = walk(21, 18, 1.0870, -0.00026, V);
  { const p = lastClose(hammer); hammer.push(K(p - 0.1 * V, p + 0.3 * V, p - 2.0 * V, p + 0.2 * V)); }
  const hammerAt = hammer.length - 1;
  hammer.push(...walk(22, 8, lastClose(hammer), 0.00024, V));

  const engulf = walk(31, 18, 1.0865, -0.00022, V);
  { const p = lastClose(engulf);
    engulf.push(K(p, p + 0.1 * V, p - 0.6 * V, p - 0.5 * V));
    const o = p - 0.55 * V, c = p + 0.9 * V;
    engulf.push(K(o, c + 0.15 * V, o - 0.1 * V, c)); }
  const engulfAt = engulf.length - 1;
  engulf.push(...walk(32, 8, lastClose(engulf), 0.00022, V));

  const star = walk(41, 18, 1.0820, 0.00026, V);
  { const p = lastClose(star); star.push(K(p, p + 2.0 * V, p - 0.25 * V, p - 0.2 * V)); }
  const starAt = star.length - 1;
  star.push(...walk(42, 8, lastClose(star), -0.00025, V));

  const doji = walk(51, 20, 1.0830, 0.00022, V);
  { const p = lastClose(doji); doji.push(K(p, p + 1.0 * V, p - 1.0 * V, p + 0.02 * V)); }
  const dojiAt = doji.length - 1;
  doji.push(...walk(52, 7, lastClose(doji), -0.00008, V));

  // Урок 4 — уровни и тренд
  const rng4 = range(61, 46, 1.0850, 0.0016, V);
  const trend4 = walk(62, 44, 1.0810, 0.00016, V);
  const tl = supportLine(trend4, 0, trend4.length - 1);

  // Урок 5 — индикаторы
  const ind = walk(71, 30, 1.0880, -0.00012, V).concat([]);
  ind.push(...walk(72, 50, lastClose(ind), 0.00014, V));
  const bb = range(73, 30, 1.0850, 0.0009, V);
  bb.push(...walk(74, 22, lastClose(bb), 0.0003, V * 1.2));
  const rsi = walk(75, 24, 1.0840, 0.0003, V);
  rsi.push(...walk(76, 20, lastClose(rsi), -0.00032, V));

  return [
    {
      id: "platform",
      emoji: "🖥",
      title: "Как устроена платформа",
      minutes: 4,
      blocks: [
        { type: "text", text: "Pocket Option — платформа для торговли бинарными опционами. Вы не покупаете валюту или акцию, а делаете прогноз: окажется ли цена выше или ниже текущей через выбранное время." },
        { type: "platform" },
        { type: "points", items: [
          "<b>Актив</b> — то, на что делается прогноз: валютная пара (EUR/USD), криптовалюта, акция, сырьё. Активы с пометкой OTC торгуются и в выходные.",
          "<b>Время (экспирация)</b> — через сколько закроется сделка: от нескольких секунд до нескольких часов.",
          "<b>Сумма</b> — сколько вы рискуете в этой сделке.",
          "<b>Доходность, %</b> — сколько вы получите сверх ставки, если прогноз верный. Если неверный — ставка теряется полностью.",
          "<b>Выше / Ниже</b> — зелёная кнопка, если ждёте рост, красная — если падение.",
        ] },
        { type: "chart", caption: "Сделка «Выше»: цена в момент экспирации оказалась выше цены входа — прогноз верный.",
          chart: { candles: l1, entry: { i: 33, dir: "up" }, vlines: [{ i: 33, label: "Вход" }, { i: 40, label: "Экспирация" }] } },
        { type: "tip", text: "Начните с <b>демо-счёта</b> — это виртуальные деньги. Переходите на реальный счёт, только когда стабильно понимаете, что делаете." },
      ],
      quiz: {
        q: "Доходность актива 85%, вы поставили $10 «Выше», и прогноз оказался верным. Сколько вы получите обратно?",
        options: ["$10", "$18.50", "$8.50", "$20"],
        answer: 1,
        explain: "Возвращается ставка $10 плюс 85% от неё ($8.50) — всего $18.50. При неверном прогнозе теряются все $10.",
      },
    },
    {
      id: "candles",
      emoji: "🕯",
      title: "Японские свечи",
      minutes: 4,
      blocks: [
        { type: "text", text: "Каждая свеча показывает, как двигалась цена за один период — например, за 1 минуту. По форме свечи видно, кто был сильнее: покупатели или продавцы." },
        { type: "anatomy" },
        { type: "points", items: [
          "<b>Тело</b> — расстояние между ценой открытия и закрытия.",
          "<b>Зелёная свеча</b> — цена выросла: закрытие выше открытия.",
          "<b>Красная свеча</b> — цена упала: закрытие ниже открытия.",
          "<b>Тени (фитили)</b> — максимум и минимум цены за период.",
          "Длинная тень говорит о том, что цену пытались увести туда, но её «вернули» обратно.",
        ] },
        { type: "tip", text: "Таймфрейм свечей и время сделки — разные настройки. Опытные трейдеры смотрят на свечи крупнее, чем время сделки, чтобы видеть общую картину." },
      ],
      quiz: {
        q: "Свеча открылась на 1.0850 и закрылась на 1.0842. Какого она цвета?",
        options: ["Зелёная", "Красная", "Серая"],
        answer: 1,
        explain: "Закрытие ниже открытия — цена за период упала, свеча красная.",
      },
    },
    {
      id: "patterns",
      emoji: "🔍",
      title: "Свечные паттерны",
      minutes: 6,
      blocks: [
        { type: "text", text: "Паттерн — повторяющаяся комбинация свечей, которая подсказывает возможный разворот. Это не гарантия: паттерн работает лучше, когда появляется у важного уровня." },
        { type: "chart", title: "Молот", caption: "Молот: после падения — маленькое тело наверху и длинная нижняя тень. Продавцы давили, но покупатели вернули цену. Возможен разворот вверх.",
          chart: { candles: hammer, marks: [{ i: hammerAt, label: "Молот", pos: "below", color: "green" }] } },
        { type: "chart", title: "Бычье поглощение", caption: "Бычье поглощение: большая зелёная свеча полностью перекрывает тело предыдущей красной. Сигнал силы покупателей.",
          chart: { candles: engulf, marks: [{ i: engulfAt, label: "Поглощение", pos: "below", color: "green" }] } },
        { type: "chart", title: "Падающая звезда", caption: "Падающая звезда: после роста — маленькое тело внизу и длинная верхняя тень. Покупатели выдохлись. Возможен разворот вниз.",
          chart: { candles: star, marks: [{ i: starAt, label: "Звезда", pos: "above", color: "red" }] } },
        { type: "chart", title: "Доджи", caption: "Доджи: открытие и закрытие почти совпадают. Рынок в нерешительности — это повод подождать подтверждения, а не входить сразу.",
          chart: { candles: doji, marks: [{ i: dojiAt, label: "Доджи", pos: "above", color: "amber" }] } },
        { type: "tip", text: "Медвежье поглощение — зеркальная версия: после роста большая красная свеча перекрывает зелёную." },
      ],
      quiz: {
        q: "После долгого роста появилась свеча с маленьким телом внизу и длинной верхней тенью. Что это?",
        options: ["Молот", "Падающая звезда", "Бычье поглощение"],
        answer: 1,
        explain: "Падающая звезда — возможный разворот вниз после роста. Молот выглядит так же, но «вверх ногами» и появляется после падения.",
      },
    },
    {
      id: "levels",
      emoji: "📐",
      title: "Тренд и уровни",
      minutes: 5,
      blocks: [
        { type: "text", text: "Прежде чем искать сигналы, определите, что делает рынок: растёт, падает или стоит в боковике." },
        { type: "chart", title: "Поддержка и сопротивление", caption: "Цена несколько раз отталкивалась от одних и тех же уровней. Чем больше касаний, тем важнее уровень.",
          chart: { candles: rng4, levels: [
            { price: r5(1.0850 + 0.0016), label: "Сопротивление", color: "red" },
            { price: r5(1.0850 - 0.0016), label: "Поддержка", color: "green" },
          ] } },
        { type: "chart", title: "Восходящий тренд", caption: "В восходящем тренде каждый минимум выше предыдущего. Линия тренда соединяет минимумы.",
          chart: { candles: trend4, trendlines: [{ ...tl, color: "green" }] } },
        { type: "points", items: [
          "<b>Поддержка</b> — уровень снизу, от которого цена отскакивает вверх.",
          "<b>Сопротивление</b> — уровень сверху, от которого цена отскакивает вниз.",
          "<b>Пробой</b> уровня часто приводит к сильному движению, а пробитое сопротивление становится поддержкой.",
          "Торговать по тренду обычно проще, чем против него.",
        ] },
      ],
      quiz: {
        q: "Цена в третий раз подошла к сопротивлению, и там появилась падающая звезда. Какой прогноз логичнее?",
        options: ["Выше", "Ниже", "Ничего нельзя сказать"],
        answer: 1,
        explain: "Уровень сопротивления и разворотный паттерн подтверждают друг друга — это вариант для «Ниже». Но гарантий нет никогда.",
      },
    },
    {
      id: "indicators",
      emoji: "📈",
      title: "Индикаторы",
      minutes: 6,
      blocks: [
        { type: "text", text: "Индикаторы — это формулы, построенные на цене. Они не предсказывают будущее, но помогают увидеть тренд, силу движения и крайние значения. На платформе их можно добавить через меню индикаторов на графике." },
        { type: "chart", title: "Скользящие средние (MA)", caption: "Быстрая MA 9 пересекла медленную MA 21 снизу вверх — признак начала роста. Пока цена выше обеих линий, тренд восходящий.",
          chart: { candles: ind, ma: [{ period: 9, color: "amber" }, { period: 21, color: "violet" }] } },
        { type: "chart", title: "Полосы Боллинджера", caption: "Полосы сужаются в спокойном рынке и расширяются при сильном движении. Сужение часто предвещает резкий выход.",
          chart: { candles: bb, bb: { period: 20, mult: 2 } } },
        { type: "chart", title: "RSI", caption: "RSI выше 70 — рынок перекуплен, ниже 30 — перепродан. Это не команда к сделке, а предупреждение, что движение может выдохнуться.",
          chart: { candles: rsi, rsi: { period: 14 } } },
        { type: "tip", text: "Не ставьте на график 5 индикаторов сразу. Одной MA и одного осциллятора (например, RSI) достаточно, чтобы не запутаться." },
      ],
      quiz: {
        q: "RSI показывает 82. Что это означает?",
        options: ["Точно будет падение", "Рынок перекуплен — рост может выдохнуться", "Нужно срочно покупать"],
        answer: 1,
        explain: "Значение выше 70 — зона перекупленности. В сильном тренде RSI может долго оставаться высоким, поэтому нужны подтверждения.",
      },
    },
    {
      id: "risk",
      emoji: "🛡",
      title: "Риск-менеджмент",
      minutes: 5,
      blocks: [
        { type: "text", text: "Бинарные опционы — высокорисковый инструмент. Большинство новичков теряют деньги не из-за плохих сигналов, а из-за отсутствия правил. Этот урок важнее всех остальных." },
        { type: "calc" },
        { type: "points", items: [
          "Рискуйте <b>не больше 1–3%</b> депозита в одной сделке.",
          "Задайте <b>лимит на день</b>: например, 3 убыточные сделки подряд — стоп до завтра.",
          "<b>Не используйте мартингейл</b> (удвоение ставки после проигрыша): серия из нескольких неудач быстро обнуляет счёт.",
          "Не пытайтесь «отыграться» — эмоции главный враг трейдера.",
          "Ведите дневник сделок: что увидели, почему вошли, чем закончилось.",
          "Торгуйте только теми деньгами, потерю которых можете себе позволить.",
        ] },
        { type: "tip", text: "При доходности 80–90% нужно угадывать больше 53–56% сделок, только чтобы выйти в ноль. Поэтому важна не частота сделок, а их качество." },
      ],
      quiz: {
        q: "Депозит $200. Сколько разумно ставить на одну сделку по правилу 2%?",
        options: ["$4", "$20", "$50", "Весь депозит, если сигнал сильный"],
        answer: 0,
        explain: "2% от $200 — это $4. Так даже серия из 10 неудач не уничтожит счёт.",
      },
    },
  ];
}
