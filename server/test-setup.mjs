// Тест автонастройки: бот, администратор и канал без ручного ввода ID.
// Запуск: node server/test-setup.mjs
import assert from "node:assert/strict";
import worker from "./worker.js";

const store = new Map();
const KV = {
  async get(k) { return store.has(k) ? store.get(k) : null; },
  async put(k, v) { store.set(k, v); },
};
const env = { AVA_KV: KV, BOT_TOKEN: "T", WEBHOOK_SECRET: "Pass_123", ALLOWED_ORIGIN: "https://vip-club-ava.vercel.app" };
const calls = [];
globalThis.fetch = async (url, init) => {
  const method = url.split("/").pop();
  const body = JSON.parse(init.body);
  calls.push({ method, body });
  if (method === "getMe") return Response.json({ ok: true, result: { username: "ava_check_bot" } });
  if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: 7 } });
  if (method === "createChatInviteLink") return Response.json({ ok: true, result: { invite_link: "https://t.me/+X" } });
  return Response.json({ ok: true, result: true });
};
const W = "https://srv.workers.dev";
const hook = (update, secret = "Pass_123") =>
  worker.fetch(new Request(W + "/telegram/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify(update),
  }), env);
const pm = (from, text) => hook({ message: { chat: { id: from, type: "private" }, from: { id: from }, text } });
const health = async () => (await (await worker.fetch(new Request(W + "/api/health"), env)).json()).configured;
const lastTo = (id) => calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === String(id)).pop();

// 1. /setup без пароля не работает, с паролем подключает webhook
let r = await worker.fetch(new Request(W + "/setup?key=wrong"), env);
assert.ok((await r.text()).includes("Нет доступа"));
r = await worker.fetch(new Request(W + "/setup?key=Pass_123"), env);
const html = await r.text();
assert.ok(html.includes("@ava_check_bot") && html.includes("Бот подключён"));
const wh = calls.find((c) => c.method === "setWebhook").body;
assert.equal(wh.url, W + "/telegram/webhook");
assert.equal(wh.secret_token, "Pass_123");
assert.ok(wh.allowed_updates.includes("channel_post"));
assert.equal(await health(), false);

// 2. Чужой не может стать админом без пароля
await pm(555, "/admin nope");
assert.equal(store.get("cfg:admin"), undefined);
assert.ok(lastTo(555).body.text.includes("Неверный"));

// 3. Канал до назначения админа игнорируется
await hook({ channel_post: { chat: { id: -1001111, type: "channel", title: "VIP" } } });
assert.equal(store.get("cfg:channel"), undefined);

// 4. Владелец назначает себя админом
await pm(777, "/admin Pass_123");
assert.equal(store.get("cfg:admin"), "777");

// 5. Пост в канале → админу приходит кнопка; чужой нажать не может; админ подтверждает
await hook({ channel_post: { chat: { id: -1001111, type: "channel", title: "AVA VIP" } } });
const offer = lastTo(777);
assert.equal(offer.body.reply_markup.inline_keyboard[0][0].callback_data, "c:-1001111");
await hook({ callback_query: { id: "x", from: { id: 555 }, data: "c:-1001111", message: { chat: { id: 555 }, message_id: 1 } } });
assert.equal(store.get("cfg:channel"), undefined);
await hook({ callback_query: { id: "y", from: { id: 777 }, data: "c:-1001111", message: { chat: { id: 777 }, message_id: 7 } } });
assert.equal(store.get("cfg:channel"), "-1001111");
assert.equal(await health(), true);

// 6. Полный цикл: заявка приходит админу, одобрение даёт ссылку в этот канал
r = await worker.fetch(new Request(W + "/api/submit", {
  method: "POST", headers: { Origin: "https://vip-club-ava.vercel.app", "CF-Connecting-IP": "1.2.3.4" },
  body: JSON.stringify({ pocketId: "88889999" }),
}), env);
assert.equal(r.status, 200);
const req = lastTo(777).body.reply_markup.inline_keyboard[0][0].callback_data;
await hook({ callback_query: { id: "z", from: { id: 777 }, data: req, message: { chat: { id: 777 }, message_id: 9 } } });
assert.equal(calls.filter((c) => c.method === "createChatInviteLink").pop().body.chat_id, "-1001111");

// 6b. Закрытая ГРУППА тоже подключается (не только канал)
store.delete("cfg:channel");
await hook({ message: { chat: { id: -1002222, type: "supergroup", title: "AVA VIP CHAT" }, from: { id: 1 }, text: "тест" } });
assert.equal(lastTo(777).body.reply_markup.inline_keyboard[0][0].callback_data, "c:-1002222");
await hook({ callback_query: { id: "g", from: { id: 777 }, data: "c:-1002222", message: { chat: { id: 777 }, message_id: 8 } } });
assert.equal(store.get("cfg:channel"), "-1002222");
// группа стала супергруппой — ID обновляется
await hook({ message: { chat: { id: -1002222, type: "group" }, from: { id: 1 }, migrate_to_chat_id: -1003333 } });
assert.equal(store.get("cfg:channel"), "-1003333");

// 7. Поддельный запрос без секрета Telegram отклоняется
assert.equal((await hook({}, "bad")).status, 403);

console.log("Автонастройка: все 8 проверок пройдены ✅");
