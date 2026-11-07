// Локальный тест сервера: настоящий Telegram НЕ вызывается,
// вместо него — заглушка, которая записывает все обращения.
// Запуск: node server/test.mjs
import assert from "node:assert/strict";
import worker from "./worker.js";

const store = new Map();
const KV = {
  async get(k) { return store.has(k) ? store.get(k) : null; },
  async put(k, v) { store.set(k, v); },
};
const env = {
  AVA_KV: KV,
  BOT_TOKEN: "TEST",
  ADMIN_CHAT_ID: "111",
  CHANNEL_ID: "-100999",
  WEBHOOK_SECRET: "s3cret",
  ALLOWED_ORIGIN: "https://vadim626.github.io",
};

const calls = [];
let failInvite = false;
globalThis.fetch = async (url, init) => {
  const method = url.split("/").pop();
  const body = JSON.parse(init.body);
  calls.push({ method, body });
  if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: 42 } });
  if (method === "createChatInviteLink") {
    if (failInvite) return Response.json({ ok: false, description: "not enough rights" });
    return Response.json({ ok: true, result: { invite_link: "https://t.me/+ONE_TIME" } });
  }
  return Response.json({ ok: true, result: true });
};

const ORIGIN = "https://vadim626.github.io";
const call = (path, opts = {}) => worker.fetch(new Request("https://w.dev" + path, opts), env);
const submit = (id, ip = "1.1.1.1", origin = ORIGIN) =>
  call("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip },
    body: JSON.stringify({ pocketId: id }),
  });
const status = (token) => call("/api/status", { headers: { Authorization: "Bearer " + token, Origin: ORIGIN } });
const press = (data, fromId = 111, secret = "s3cret") =>
  call("/telegram/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({
      callback_query: { id: "cb", from: { id: fromId }, data, message: { chat: { id: 111 }, message_id: 42 } },
    }),
  });
const lastAdminReqId = () => {
  const m = calls.filter((c) => c.method === "sendMessage").pop();
  return m.body.reply_markup.inline_keyboard[0][0].callback_data.slice(2);
};

// 1. Неверный ID отклоняется
assert.equal((await submit("abc")).status, 400);
// 2. Чужой сайт не может отправлять заявки
assert.equal((await submit("12345678", "9.9.9.9", "https://evil.com")).status, 403);

// 3. Нормальная заявка → админу приходит сообщение с кнопками
let r = await submit("12345678");
assert.equal(r.status, 200);
const { token } = await r.json();
assert.match(token, /^[0-9a-f]{64}$/);
const reqId = lastAdminReqId();
assert.ok(calls.at(-1).body.text.includes("12345678"));

// 4. Пока админ не нажал — статус «ожидает», ссылки нет
let s = await (await status(token)).json();
assert.equal(s.status, "pending");
assert.equal(s.inviteLink, undefined);

// 5. Неверный ключ — нет доступа к чужой заявке
assert.equal((await status("0".repeat(64))).status, 404);
assert.equal((await status("bad")).status, 401);

// 6. Посторонний не может нажать кнопку; поддельный webhook отклоняется
await press("a:" + reqId, 999);
assert.equal((await (await status(token)).json()).status, "pending");
assert.equal((await press("a:" + reqId, 111, "wrong")).status, 403);

// 7. Если бот не админ канала — доступ НЕ выдаётся, заявка остаётся ожидающей
failInvite = true;
await press("a:" + reqId);
assert.equal((await (await status(token)).json()).status, "pending");
failInvite = false;

// 8. Админ одобряет → появляется одноразовая ссылка
await press("a:" + reqId);
s = await (await status(token)).json();
assert.equal(s.status, "approved");
assert.equal(s.inviteLink, "https://t.me/+ONE_TIME");
const inviteCall = calls.filter((c) => c.method === "createChatInviteLink").pop();
assert.equal(inviteCall.body.member_limit, 1);

// 9. Повторное нажатие ничего не меняет
await press("r:" + reqId);
assert.equal((await (await status(token)).json()).status, "approved");

// 10. Отклонение работает; повторный ID помечается для админа
r = await submit("12345678", "2.2.2.2");
const t2 = (await r.json()).token;
assert.ok(calls.filter((c) => c.method === "sendMessage").pop().body.text.includes("уже подавали"));
await press("r:" + lastAdminReqId());
s = await (await status(t2)).json();
assert.equal(s.status, "rejected");
assert.equal(s.inviteLink, undefined);

// 11. Защита от спама: 6-я заявка за час с одного IP блокируется
for (let i = 0; i < 4; i++) assert.equal((await submit("5555555" + i, "3.3.3.3")).status, 200);
assert.equal((await submit("55555559", "3.3.3.3")).status, 200);
assert.equal((await submit("55555560", "3.3.3.3")).status, 429);

// 12. Если Telegram недоступен — честная ошибка, а не «успех»
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("network down"); };
assert.equal((await submit("77777777", "4.4.4.4")).status, 502);
globalThis.fetch = realFetch;

// 13. Без настроек сервер честно говорит, что не настроен
const bare = await worker.fetch(
  new Request("https://w.dev/api/submit", { method: "POST", body: "{}" }), { AVA_KV: KV });
assert.equal(bare.status, 503);

console.log("Все 13 проверок пройдены ✅");
