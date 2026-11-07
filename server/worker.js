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
import { academyLessons } from "./academy.js";

const INVITE_TTL = 60 * 60 * 24 * 7;    // одноразовая ссылка действует 7 дней
const RECHECK_COOLDOWN = 10 * 60;       // «Я пополнил» — не чаще раза в 10 минут
const DEFAULT_MIN_DEPOSIT = 10;         // минимальное пополнение, $ (можно задать MIN_DEPOSIT)

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
      if (url.pathname === "/api/recheck" && request.method === "POST") {
        return await handleRecheck(request, env, cors);
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

  const bot = await botUsername(env);
  if (!bot) {
    return json({ error: "telegram_unavailable" }, 502, cors);
  }

  const reqId = randomHex(8);    // короткий номер заявки (виден админу)
  const token = randomHex(32);   // секретный ключ посетителя (только у него)
  const linkCode = randomHex(12); // код для кнопки «Подтвердить Telegram»
  const record = {
    reqId,
    pocketId,
    tokenHash: await sha256(token),
    linkCode,
    status: "awaiting_tg",
    createdAt: new Date().toISOString(),
  };

  // Этот ID уже одобряли и знаем его Telegram — после подтверждения
  // того же Telegram доступ откроется сразу, без администратора.
  const prevId = (await env.AVA_KV.get("apr:" + pocketId)) || (await env.AVA_KV.get("pid:" + pocketId));
  const prev = prevId ? await getRequest(env, prevId) : null;
  if (prev && prev.status === "approved" && prev.tg && prev.tg.id) {
    record.expectTgId = prev.tg.id;
    record.reapproveOf = prev.reqId;
  }

  await saveRequest(env, record);
  await env.AVA_KV.put("tok:" + record.tokenHash, reqId, { expirationTtl: REQUEST_TTL });
  await env.AVA_KV.put("link:" + linkCode, reqId, { expirationTtl: REQUEST_TTL });

  return json(
    { token, status: record.status, pocketId, telegramLink: tgLink(bot, linkCode), returning: Boolean(record.expectTgId) },
    200,
    cors,
  );
}

// Посетитель сообщил «Я пополнил» на сайте.
async function handleRecheck(request, env, cors) {
  if (!isAllowedOrigin(request, env)) return json({ error: "forbidden_origin" }, 403, cors);
  const found = await findByToken(request, env);
  if (found.error) return json({ error: found.error }, found.code, cors);
  const res = await requestRecheck(env, found.record);
  if (res.error) return json(res, res.error === "too_soon" ? 429 : 409, cors);
  return json({ status: "pending" }, 200, cors);
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

  const out = { status: record.status, pocketId: record.pocketId, minDeposit: minDeposit(env) };
  if (record.status === "awaiting_tg" && record.linkCode) {
    const bot = await botUsername(env);
    if (bot) out.telegramLink = tgLink(bot, record.linkCode);
  }
  if (record.tg && record.tg.username) out.telegram = "@" + record.tg.username;
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

  // Группа превратилась в супергруппу — у неё меняется ID, обновляем.
  if (msg && msg.migrate_to_chat_id && String(msg.chat.id) === String(env.CHANNEL_ID)) {
    await env.AVA_KV.put("cfg:channel", String(msg.migrate_to_chat_id));
    return new Response("ok");
  }

  // Бот увидел закрытый канал или группу (его добавили админом / новое сообщение)
  const CLUB_TYPES = ["channel", "group", "supergroup"];
  const clubChat =
    (update.channel_post && update.channel_post.chat) ||
    (msg && msg.chat) ||
    (update.my_chat_member && update.my_chat_member.chat);
  if (clubChat && CLUB_TYPES.includes(clubChat.type)) {
    await offerChannel(env, clubChat);
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
      text: "✅ VIP-группа подключена. Теперь при одобрении заявок бот будет выдавать одноразовые ссылки в неё.",
    });
    await answer(env, cb.id, "Подключено ✅");
    return new Response("ok");
  }

  // Кнопка «Я пополнил» — её нажимает сам участник в чате с ботом.
  const paid = /^p:([0-9a-f]{16})$/.exec(cb.data || "");
  if (paid) {
    const rec = await getRequest(env, paid[1]);
    if (!rec || !rec.tg || String(rec.tg.id) !== String(cb.from.id)) {
      await answer(env, cb.id, "Заявка не найдена");
      return new Response("ok");
    }
    const res = await requestRecheck(env, rec);
    if (res.error === "too_soon") {
      await answer(env, cb.id, "Подождите " + Math.ceil(res.waitSec / 60) + " мин. перед повторной проверкой", true);
    } else if (res.error) {
      await answer(env, cb.id, "Заявка уже на проверке или обработана");
    } else {
      await answer(env, cb.id, "Отправлено на проверку ✅");
      await telegram(env, "sendMessage", { chat_id: cb.from.id, text: "🔁 Отправил администратору на повторную проверку. Ответ придёт сюда и на сайт." });
    }
    return new Response("ok");
  }

  // Остальные кнопки может нажимать только администратор.
  if (String(cb.from.id) !== String(env.ADMIN_CHAT_ID)) {
    await answer(env, cb.id, "Нет доступа");
    return new Response("ok");
  }

  const match = /^(a|r|n):([0-9a-f]{16})$/.exec(cb.data || "");
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
        "Не удалось создать ссылку. Бот должен быть администратором VIP-группы с правом приглашать пользователей.",
        true,
      );
      return new Response("ok");
    }
    record.status = "approved";
    record.inviteLink = link.result.invite_link;
    record.inviteExpiresAt = link.expiresAt;
  } else if (action === "n") {
    record.status = "needs_deposit";
  } else {
    record.status = "rejected";
  }

  record.decidedAt = new Date().toISOString();
  await saveRequest(env, record);
  if (record.status === "approved") {
    await env.AVA_KV.put("apr:" + record.pocketId, record.reqId, { expirationTtl: REQUEST_TTL });
  }

  await telegram(env, "editMessageText", {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    text: adminMessageText(record),
    parse_mode: "HTML",
  });
  await notifyMember(env, record);
  await answer(env, cb.id, { approved: "Одобрено ✅", rejected: "Отклонено ❌", needs_deposit: "Отмечено: не пополнен 💰" }[record.status]);
  return new Response("ok");
}

/* ---------- Заявки: Telegram участника, уведомления ---------- */

function minDeposit(env) {
  const n = Number(env.MIN_DEPOSIT);
  return n > 0 ? n : DEFAULT_MIN_DEPOSIT;
}

function tgLink(bot, code) {
  return "https://t.me/" + bot + "?start=" + code;
}

// Имя бота (нужно для кнопки «Подтвердить Telegram»), кешируется в KV.
async function botUsername(env) {
  const cached = await env.AVA_KV.get("cfg:botname");
  if (cached) return cached;
  const me = await telegram(env, "getMe", {});
  if (!me.ok || !me.result || !me.result.username) return null;
  await env.AVA_KV.put("cfg:botname", me.result.username, { expirationTtl: 60 * 60 * 24 });
  return me.result.username;
}

// Участник нажал «Запустить» в боте по ссылке с сайта.
async function linkTelegram(env, msg, code) {
  const reply = (t, extra) => telegram(env, "sendMessage", { chat_id: msg.chat.id, text: t, ...(extra || {}) });
  const reqId = await env.AVA_KV.get("link:" + code);
  const record = reqId ? await getRequest(env, reqId) : null;
  if (!record) {
    await reply("Ссылка устарела. Введите ID на сайте ещё раз.");
    return;
  }
  if (record.tg && String(record.tg.id) !== String(msg.from.id)) {
    await reply("Эта заявка уже привязана к другому Telegram-аккаунту.");
    return;
  }
  if (record.status !== "awaiting_tg") {
    await reply("Ваша заявка с ID " + record.pocketId + ": " + statusRu(record.status) + ". Ответ придёт сюда и на сайт.");
    return;
  }

  const from = msg.from || {};
  record.tg = {
    id: from.id,
    username: from.username || null,
    name: [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 64),
  };
  // Возвращающийся участник: тот же Telegram, что был одобрен раньше — вход сразу.
  if (record.expectTgId && String(record.expectTgId) === String(from.id)) {
    const link = await createInvite(env, record.pocketId);
    if (link.ok) {
      record.status = "approved";
      record.autoApproved = true;
      record.inviteLink = link.result.invite_link;
      record.inviteExpiresAt = link.expiresAt;
      record.decidedAt = new Date().toISOString();
      await saveRequest(env, record);
      await env.AVA_KV.put("pid:" + record.pocketId, record.reqId, { expirationTtl: REQUEST_TTL });
      await env.AVA_KV.put("apr:" + record.pocketId, record.reqId, { expirationTtl: REQUEST_TTL });
      await env.AVA_KV.put("tgu:" + from.id, record.reqId, { expirationTtl: REQUEST_TTL });
      await notifyMember(env, record);
      await telegram(env, "sendMessage", {
        chat_id: env.ADMIN_CHAT_ID,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        text: "🔁 <b>Повторный вход</b>\n\n" + memberLine(record) +
          "\n\nЭтот ID вы уже одобряли, Telegram совпал — доступ выдан автоматически.",
      });
      return;
    }
    console.error("auto re-approve invite failed", link.description);
  }

  record.status = "pending";

  // Подавал ли этот ID или этот Telegram что-то раньше — подскажем администратору.
  const warnings = [];
  if (record.expectTgId && String(record.expectTgId) !== String(from.id)) {
    warnings.push("Этот ID уже был одобрен для ДРУГОГО Telegram-аккаунта. Возможно, кто-то вводит чужой ID.");
  }
  const prevByPid = await env.AVA_KV.get("pid:" + record.pocketId);
  if (prevByPid && prevByPid !== record.reqId) {
    const prev = await getRequest(env, prevByPid);
    if (prev) warnings.push("Этот ID уже подавали раньше (статус: " + statusRu(prev.status) + ").");
  }
  const prevByTg = await env.AVA_KV.get("tgu:" + from.id);
  if (prevByTg && prevByTg !== record.reqId) {
    const prev = await getRequest(env, prevByTg);
    if (prev && prev.pocketId !== record.pocketId) warnings.push("Этот Telegram раньше присылал другой ID: " + prev.pocketId + ".");
  }

  const ok = await notifyAdmin(env, record, warnings);
  if (!ok) {
    await reply("Не удалось отправить заявку. Попробуйте через минуту — нажмите «Запустить» ещё раз.");
    return;
  }
  await saveRequest(env, record);
  await env.AVA_KV.put("pid:" + record.pocketId, record.reqId, { expirationTtl: REQUEST_TTL });
  await env.AVA_KV.put("tgu:" + from.id, record.reqId, { expirationTtl: REQUEST_TTL });
  await reply(
    "✅ Заявка отправлена!\n\nPocket Option ID: " + record.pocketId +
    "\nАдминистратор проверит регистрацию и пополнение счёта. Ответ придёт сюда и на сайт.",
  );
}

// Отправляет администратору заявку с кнопками. Возвращает true при успехе.
async function notifyAdmin(env, record, warnings, note) {
  const sent = await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_CHAT_ID,
    text: adminMessageText(record, warnings, note),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: pendingKeyboard(record.reqId),
  });
  if (!sent.ok) {
    console.error("sendMessage to admin failed", sent.description);
    return false;
  }
  record.adminMessageId = sent.result.message_id;
  return true;
}

// Сообщает участнику в Telegram о решении администратора.
async function notifyMember(env, record) {
  if (!record.tg || !record.tg.id) return;
  const chat_id = record.tg.id;
  if (record.status === "approved" && record.inviteLink) {
    await telegram(env, "sendMessage", {
      chat_id,
      text: "🎉 Ваш ID " + record.pocketId + " подтверждён! Добро пожаловать в AVA TRADE VIP.\n\nСсылка персональная и одноразовая — не передавайте её другим.",
      reply_markup: { inline_keyboard: [[{ text: "Вступить в VIP-чат", url: record.inviteLink }]] },
    });
  } else if (record.status === "needs_deposit") {
    await telegram(env, "sendMessage", {
      chat_id,
      text:
        "💰 Регистрация по ID " + record.pocketId + " найдена, но счёт ещё не пополнен.\n\n" +
        "Для вступления в VIP пополните счёт минимум на $" + minDeposit(env) + ", затем нажмите кнопку ниже.",
      reply_markup: { inline_keyboard: [[{ text: "✅ Я пополнил", callback_data: "p:" + record.reqId }]] },
    });
  } else if (record.status === "rejected") {
    await telegram(env, "sendMessage", {
      chat_id,
      text: "ID " + record.pocketId + " не подтверждён. Проверьте, что аккаунт создан по ссылке клуба, или напишите администратору.",
    });
  }
}

// «Я пополнил»: возвращает заявку администратору на повторную проверку.
async function requestRecheck(env, record) {
  if (record.status !== "needs_deposit") return { error: "not_waiting_deposit" };
  const since = nowSec() - (record.recheckAt || 0);
  if (since < RECHECK_COOLDOWN) return { error: "too_soon", waitSec: RECHECK_COOLDOWN - since };
  record.status = "pending";
  record.recheckAt = nowSec();
  const ok = await notifyAdmin(env, record, [], "🔁 Повторная проверка: участник сообщил, что пополнил счёт.");
  if (!ok) return { error: "telegram_unavailable" };
  await saveRequest(env, record);
  return { ok: true };
}

function memberLine(record) {
  const lines = ["Pocket Option ID: <code>" + record.pocketId + "</code>"];
  if (record.tg) {
    const who = record.tg.username ? "@" + escapeHtml(record.tg.username) : "без username";
    lines.push("Telegram: <a href=\"tg://user?id=" + record.tg.id + "\">" + who + "</a>" + (record.tg.name ? " · " + escapeHtml(record.tg.name) : ""));
  }
  return lines.join("\n");
}

function escapeHtml(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ============================================================
   ВСПОМОГАТЕЛЬНОЕ
   ============================================================ */

function adminMessageText(record, warnings, note) {
  const decided = record.status !== "pending";
  const lines = [decided ? "<b>Заявка AVA TRADE</b>" : "<b>Новая заявка AVA TRADE</b>", ""];
  if (note && !decided) lines.push(note, "");
  lines.push("Pocket Option ID: <code>" + record.pocketId + "</code>");
  if (record.tg) {
    const who = record.tg.username ? "@" + escapeHtml(record.tg.username) : "без username";
    lines.push("Telegram: <a href=\"tg://user?id=" + record.tg.id + "\">" + who + "</a>" + (record.tg.name ? " · " + escapeHtml(record.tg.name) : ""));
  }
  lines.push("Заявка: #" + record.reqId, "Время: " + record.createdAt.replace("T", " ").slice(0, 16) + " UTC");
  (warnings || []).forEach((w) => lines.push("", "⚠️ " + w));
  if (decided) lines.push("", "Решение: " + statusRu(record.status));
  else lines.push("", "Проверьте ID и пополнение в PocketPartners Bot и нажмите кнопку.");
  return lines.join("\n");
}

function statusRu(status) {
  return {
    awaiting_tg: "ждёт подтверждения Telegram",
    pending: "на проверке ⏳",
    needs_deposit: "не пополнен 💰",
    approved: "одобрено ✅",
    rejected: "отклонено ❌",
  }[status] || status;
}

function pendingKeyboard(reqId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Одобрить", callback_data: "a:" + reqId },
        { text: "❌ Отклонить", callback_data: "r:" + reqId },
      ],
      [{ text: "💰 Не пополнен", callback_data: "n:" + reqId }],
    ],
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

  const startLink = /^\/start\s+([0-9a-f]{24})$/.exec(text);
  if (startLink) {
    await linkTelegram(env, msg, startLink[1]);
    return;
  }

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
        ? "VIP-группа уже подключена — всё готово. Заявки с сайта будут приходить сюда."
        : "Последний шаг: напишите любое сообщение в вашей закрытой VIP-группе (потом его можно удалить). Я пришлю кнопку, чтобы её подтвердить."),
    );
    return;
  }

  if (String(msg.from.id) === String(env.ADMIN_CHAT_ID)) {
    await reply(
      "AVA TRADE бот работает ✅\n" +
      "VIP-группа: " + (env.CHANNEL_ID ? "подключена" : "не подключена — напишите сообщение в группе") + "\n" +
      "Заявки с сайта приходят сюда с кнопками ✅ / ❌ / 💰.",
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
      "Бот видит " + (chat.type === "channel" ? "канал" : "группу") + " «" + (chat.title || "без названия") + "».\n" +
      (env.CHANNEL_ID ? "Сейчас подключена другая. Заменить на эту?" : "Это ваша закрытая VIP-группа?"),
    reply_markup: { inline_keyboard: [[{ text: "✅ Да, это моя VIP-группа", callback_data: "c:" + chat.id }]] },
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
    (env.CHANNEL_ID ? "✅ VIP-группа подключена" : "⏳ VIP-группа: напишите любое сообщение в закрытой группе и нажмите кнопку, которую пришлёт бот"),
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
