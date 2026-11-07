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
  if (method === "getMe") return Response.json({ ok: true, result: { username: "ava_trade_check_bot" } });
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
const toChat = (id) => calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === String(id));
const lastAdminReqId = () => toChat(111).pop().body.reply_markup.inline_keyboard[0][0].callback_data.slice(2);
// Участник нажимает «Запустить» в боте по ссылке с сайта
const startTg = (link, tgId, username) =>
  call("/telegram/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret" },
    body: JSON.stringify({ message: { chat: { id: tgId, type: "private" }, from: { id: tgId, username, first_name: "Иван" },
      text: "/start " + link.split("start=")[1] } }),
  });
const recheck = (token) => call("/api/recheck", { method: "POST", headers: { Authorization: "Bearer " + token, Origin: ORIGIN } });

// 1. Неверный ID отклоняется
assert.equal((await submit("abc")).status, 400);
// 2. Чужой сайт не может отправлять заявки
assert.equal((await submit("12345678", "9.9.9.9", "https://evil.com")).status, 403);

// 3. Заявка с сайта ждёт подтверждения Telegram — админ пока ничего не получает
let r = await submit("12345678");
assert.equal(r.status, 200);
const sub = await r.json();
const { token } = sub;
assert.match(token, /^[0-9a-f]{64}$/);
assert.equal(sub.status, "awaiting_tg");
assert.match(sub.telegramLink, /^https:\/\/t\.me\/ava_trade_check_bot\?start=[0-9a-f]{24}$/);
assert.equal(toChat(111).length, 0, "админу ещё ничего не пришло");
assert.equal((await (await status(token)).json()).telegramLink, sub.telegramLink);

// 3b. Участник нажал «Запустить» в боте → админу заявка с ID и @username, участнику — подтверждение
await startTg(sub.telegramLink, 5001, "ivan_trader");
const adm = toChat(111).pop().body;
assert.ok(adm.text.includes("12345678") && adm.text.includes("@ivan_trader") && adm.text.includes("tg://user?id=5001"));
const kb = adm.reply_markup.inline_keyboard.flat().map((b) => b.callback_data[0]);
assert.deepEqual(kb, ["a", "r", "n"], "три кнопки: одобрить, отклонить, не пополнен");
assert.ok(toChat(5001).pop().body.text.includes("Заявка отправлена"));
const reqId = lastAdminReqId();
// чужой Telegram не может перехватить чужую заявку
await startTg(sub.telegramLink, 6006, "thief");
assert.ok(toChat(6006).pop().body.text.includes("другому Telegram"));

// 4. Пока админ не нажал — статус «ожидает», ссылки нет
let s = await (await status(token)).json();
assert.equal(s.status, "pending");
assert.equal(s.inviteLink, undefined);
assert.equal(s.telegram, "@ivan_trader");

// 5. Неверный ключ — нет доступа к чужой заявке
assert.equal((await status("0".repeat(64))).status, 404);
assert.equal((await status("bad")).status, 401);

// 6. Посторонний не может нажать кнопку; поддельный webhook отклоняется
await press("a:" + reqId, 999);
assert.equal((await (await status(token)).json()).status, "pending");
assert.equal((await press("a:" + reqId, 111, "wrong")).status, 403);

// 6b. Уроки академии закрыты, пока ID не одобрен
const academy = (t) => call("/api/academy", { headers: { Authorization: "Bearer " + t, Origin: ORIGIN } });
assert.equal((await academy(token)).status, 403);
assert.equal((await academy("0".repeat(64))).status, 404);

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
// ссылка пришла участнику и в Telegram
assert.equal(toChat(5001).pop().body.reply_markup.inline_keyboard[0][0].url, "https://t.me/+ONE_TIME");

assert.ok(inviteCall.body.expire_date > Date.now() / 1000 + 6 * 86400);

// 8b. Ссылка истекла → при возврате на сайт выдаётся новая
const rec = JSON.parse(store.get("req:" + reqId));
rec.inviteExpiresAt = 1;
store.set("req:" + reqId, JSON.stringify(rec));
const before = calls.filter((c) => c.method === "createChatInviteLink").length;
s = await (await status(token)).json();
assert.equal(s.status, "approved");
assert.ok(s.inviteLink);
assert.equal(calls.filter((c) => c.method === "createChatInviteLink").length, before + 1);
assert.ok(JSON.parse(store.get("req:" + reqId)).inviteExpiresAt > 1);

// 8c. После одобрения уроки открываются, данные графиков корректны
const ar = await academy(token);
assert.equal(ar.status, 200);
const { lessons } = await ar.json();
assert.equal(lessons.length, 19);
assert.equal(new Set(lessons.map((l) => l.id)).size, 19, "id уроков уникальны");
for (const l of lessons) {
  assert.ok(l.title && l.blocks.length && l.quiz.options[l.quiz.answer]);
  for (const b of l.blocks.filter((b) => b.type === "chart")) {
    for (const [o, h, lo, c] of b.chart.candles) {
      assert.ok(h >= Math.max(o, c) && lo <= Math.min(o, c), "свеча с неверными тенями в " + l.id);
    }
  }
}
// Пример сделки «Выше» в уроке 1 действительно заканчивается выше входа
const ex = lessons.find((l) => l.id === "platform").blocks.find((b) => b.type === "chart").chart;
assert.ok(ex.candles[40][3] > ex.candles[33][3], "пример сделки «Выше» должен быть в плюс");
// Паттерны выглядят как паттерны
const pat = lessons.find((l) => l.id === "patterns").blocks.filter((b) => b.type === "chart").map((b) => b.chart);
const body = ([o, , , c]) => Math.abs(c - o);
const [hm, hh, hl, hc] = pat[0].candles[pat[0].marks[0].i];
assert.ok(Math.min(hm, hc) - hl > 2 * body([hm, 0, 0, hc]) && hh - Math.max(hm, hc) < body([hm, 0, 0, hc]) * 2, "молот");
const eg = pat[1].candles, ei = pat[1].marks[0].i;
assert.ok(eg[ei][3] > eg[ei][0] && eg[ei - 1][3] < eg[ei - 1][0] && eg[ei][0] <= eg[ei - 1][3] && eg[ei][3] >= eg[ei - 1][0], "поглощение");
const [so, sh, sl, sc] = pat[2].candles[pat[2].marks[0].i];
assert.ok(sh - Math.max(so, sc) > 2 * body([so, 0, 0, sc]), "падающая звезда");
import("node:fs").then((fs) => fs.writeFileSync(process.env.ACADEMY_OUT || "/dev/null", JSON.stringify({ lessons })));

// 9. Повторное нажатие ничего не меняет
await press("r:" + reqId);
assert.equal((await (await status(token)).json()).status, "approved");

// 10. Отклонение работает; повторный ID помечается для админа
r = await submit("12345678", "2.2.2.2");
const sub2 = await r.json();
const t2 = sub2.token;
await startTg(sub2.telegramLink, 7007, "other_guy");
assert.ok(toChat(111).pop().body.text.includes("уже подавали"));
await press("r:" + lastAdminReqId());
s = await (await status(t2)).json();
assert.equal(s.status, "rejected");
assert.equal(s.inviteLink, undefined);
assert.ok(toChat(7007).pop().body.text.includes("не подтверждён"));

// 10a. Тот же владелец заходит снова (новое устройство) — вход сразу, без администратора
r = await submit("12345678", "2.2.2.3");
const back = await r.json();
assert.equal(back.returning, true);
const adminCount = toChat(111).length;
const invitesBefore = calls.filter((c) => c.method === "createChatInviteLink").length;
await startTg(back.telegramLink, 5001, "ivan_trader");
s = await (await status(back.token)).json();
assert.equal(s.status, "approved", "одобрен автоматически");
assert.ok(s.inviteLink);
assert.equal(calls.filter((c) => c.method === "createChatInviteLink").length, invitesBefore + 1, "новая одноразовая ссылка");
assert.equal(toChat(111).length, adminCount + 1);
assert.ok(toChat(111).pop().body.text.includes("Повторный вход"));
assert.equal(toChat(111).at(-1).body.reply_markup, undefined, "без кнопок — решать ничего не нужно");
assert.equal(toChat(5001).pop().body.reply_markup.inline_keyboard[0][0].url, "https://t.me/+ONE_TIME");

// 10a-2. Чужой Telegram вводит одобренный ID — автоматически НЕ пускаем, админу предупреждение
r = await submit("12345678", "2.2.2.4");
const thief = await r.json();
assert.equal(thief.returning, true);
await startTg(thief.telegramLink, 6666, "stranger");
assert.equal((await (await status(thief.token)).json()).status, "pending");
assert.ok(toChat(111).pop().body.text.includes("ДРУГОГО Telegram"));
// …и это не ломает быстрый вход настоящему владельцу
r = await submit("12345678", "2.2.2.5");
const back2 = await r.json();
await startTg(back2.telegramLink, 5001, "ivan_trader");
assert.equal((await (await status(back2.token)).json()).status, "approved");

// 10b. «Не пополнен» → участнику сообщение с кнопкой «Я пополнил», на сайте — статус needs_deposit
r = await submit("44440000", "5.5.5.5");
const sub3 = await r.json();
await startTg(sub3.telegramLink, 8008, "no_money");
const req3 = lastAdminReqId();
await press("n:" + req3);
s = await (await status(sub3.token)).json();
assert.equal(s.status, "needs_deposit");
assert.equal(s.minDeposit, 10);
const dm = toChat(8008).pop().body;
assert.ok(dm.text.includes("не пополнен") && dm.text.includes("$10"));
assert.equal(dm.reply_markup.inline_keyboard[0][0].callback_data, "p:" + req3);
// чужой не может нажать «Я пополнил» за другого
await press("p:" + req3, 9999);
assert.equal((await (await status(sub3.token)).json()).status, "needs_deposit");
// участник нажимает «Я пополнил» в Telegram → админу повторная заявка
const adminBefore = toChat(111).length;
await press("p:" + req3, 8008);
assert.equal((await (await status(sub3.token)).json()).status, "pending");
assert.equal(toChat(111).length, adminBefore + 1);
assert.ok(toChat(111).pop().body.text.includes("Повторная проверка"));
// админ снова отмечает «не пополнен»; повторная кнопка на сайте сразу — слишком рано
await press("n:" + req3);
assert.equal((await recheck(sub3.token)).status, 429);
// через 10 минут — можно, с сайта
const r3 = JSON.parse(store.get("req:" + req3));
r3.recheckAt = 1;
store.set("req:" + req3, JSON.stringify(r3));
assert.equal((await recheck(sub3.token)).status, 200);
assert.equal((await (await status(sub3.token)).json()).status, "pending");
// и теперь одобряем
await press("a:" + req3);
assert.equal((await (await status(sub3.token)).json()).status, "approved");

// 11. Защита от спама: 6-я заявка за час с одного IP блокируется
for (let i = 0; i < 4; i++) assert.equal((await submit("5555555" + i, "3.3.3.3")).status, 200);
assert.equal((await submit("55555559", "3.3.3.3")).status, 200);
assert.equal((await submit("55555560", "3.3.3.3")).status, 429);

// 12. Если Telegram недоступен — честная ошибка, а не «успех»
store.delete("cfg:botname");
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("network down"); };
assert.equal((await submit("77777777", "4.4.4.4")).status, 502);
globalThis.fetch = realFetch;

// 13. Без настроек сервер честно говорит, что не настроен
const bare = await worker.fetch(
  new Request("https://w.dev/api/submit", { method: "POST", body: "{}" }), { AVA_KV: KV });
assert.equal(bare.status, 503);

console.log("Все 28 проверок пройдены ✅");
