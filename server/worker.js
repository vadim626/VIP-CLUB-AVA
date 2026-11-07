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
 * Все секреты хранятся в настройках Cloudflare (не в коде):
 *   BOT_TOKEN       — токен вашего бота от @BotFather
 *   ADMIN_CHAT_ID   — ваш Telegram ID (куда приходят заявки)
 *   CHANNEL_ID      — ID закрытого канала (например -1001234567890)
 *   WEBHOOK_SECRET  — случайная строка, защищает адрес для Telegram
 *   ALLOWED_ORIGIN  — адрес сайта, например https://vadim626.github.io
 * Хранилище: KV-пространство с именем привязки AVA_KV.
 */

const REQUEST_TTL = 60 * 60 * 24 * 60; // заявки хранятся 60 дней
const RATE_LIMIT_MAX = 5;               // не больше 5 заявок…
const RATE_LIMIT_WINDOW = 60 * 60;      // …в час с одного IP
const ID_PATTERN = /^\d{5,12}$/;        // Pocket Option ID — только цифры
const INVITE_TTL = 60 * 60 * 24 * 7;    // одноразовая ссылка действует 7 дней

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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

async function handleStatus(request, env, cors) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return json({ error: "unauthorized" }, 401, cors);
  }

  const reqId = await env.AVA_KV.get("tok:" + (await sha256(token)));
  const record = reqId ? await getRequest(env, reqId) : null;
  if (!record) {
    return json({ error: "not_found" }, 404, cors);
  }

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

  if (update.message && update.message.text && update.message.text.startsWith("/start")) {
    // Помогает при настройке: бот сообщает ваш Telegram ID.
    await telegram(env, "sendMessage", {
      chat_id: update.message.chat.id,
      text: "AVA TRADE бот работает.\nВаш Telegram ID: " + update.message.from.id,
    });
    return new Response("ok");
  }

  const cb = update.callback_query;
  if (!cb) return new Response("ok");

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

function isAllowedOrigin(request, env) {
  const list = allowedOrigins(env);
  if (list.length === 0) return true; // не настроено — пускаем (удобно для теста)
  return list.includes(request.headers.get("Origin") || "");
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const list = allowedOrigins(env);
  const allow = list.length === 0 ? "*" : list.includes(origin) ? origin : list[0];
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
