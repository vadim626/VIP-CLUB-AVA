// Тест клуба: проверка перед торговлей, турнир, дуэли, итоги недели.
// Telegram — заглушка, время подменяется. Запуск: node server/test-club.mjs
import assert from "node:assert/strict";
import worker from "./worker.js";
import { weekInfo, evaluateCheck } from "./club.js";

const store = new Map();
const KV = { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); } };
const env = {
  AVA_KV: KV, BOT_TOKEN: "T", WEBHOOK_SECRET: "sec", ADMIN_CHAT_ID: "111", CHANNEL_ID: "-100",
  ALLOWED_ORIGIN: "https://vip-club-ava.vercel.app", CARDS_URL: "https://srv.dev/cards",
};
store.set("cfg:hookv", "x");
const calls = [];
let inv = 0;
globalThis.fetch = async (url, init) => {
  const method = url.split("/").pop();
  const body = JSON.parse(init.body);
  calls.push({ method, body });
  if (method === "getMe") return Response.json({ ok: true, result: { username: "ava_bot" } });
  if (method === "createChatInviteLink") return Response.json({ ok: true, result: { invite_link: "https://t.me/+L" + inv++ } });
  return Response.json({ ok: true, result: { message_id: 1 } });
};
const ORIGIN = "https://vip-club-ava.vercel.app";
const call = (path, opts = {}) => worker.fetch(new Request("https://srv.dev" + path, opts), env);
const hook = (u) => call("/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "sec" }, body: JSON.stringify(u) });
const api = async (token, path, method = "GET", body) => {
  const r = await call(path, { method, headers: { Authorization: "Bearer " + token, Origin: ORIGIN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const photos = (chat) => calls.filter((c) => c.method === "sendPhoto" && String(c.body.chat_id) === String(chat));

let ip = 1;
async function member(pid, tgId, name) {
  const r = await call("/api/submit", { method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": "9.9.9." + ip++ }, body: JSON.stringify({ pocketId: pid }) });
  const { token, telegramLink } = await r.json();
  await hook({ message: { chat: { id: tgId, type: "private" }, from: { id: tgId, first_name: name }, text: "/start " + telegramLink.split("start=")[1] } });
  const adm = calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === "111").pop();
  const req = adm.body.reply_markup.inline_keyboard[0][0].callback_data;
  await hook({ callback_query: { id: "c", from: { id: 111 }, data: req, message: { chat: { id: 111 }, message_id: 1 } } });
  return token;
}

// Подмена времени
const realNow = Date.now;
let fake = null;
Date.now = () => (fake === null ? realNow() : fake * 1000);

const A = await member("10000001", 501, "Анна");
const B = await member("10000002", 502, "Борис");

// 1. Клуб закрыт для неодобренных
const r0 = await call("/api/submit", { method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": "8.8.8.8" }, body: JSON.stringify({ pocketId: "99999999" }) });
const notYet = (await r0.json()).token;
assert.equal((await api(notYet, "/api/club/tour")).status, 403);

// 2. Проверка перед торговлей
assert.equal(evaluateCheck([0, 0, 0, 0, 0]).level, "green");
assert.equal(evaluateCheck([1, 1, 0, 0, 0]).level, "yellow");
assert.equal(evaluateCheck([0, 0, 2, 0, 0]).level, "red", "желание отыграться = красный");
assert.equal(evaluateCheck([0, 0, 0, 0, 1]).level, "red", "нужные деньги = красный");
assert.equal(evaluateCheck([9, 0, 0, 0, 0]), null);
assert.equal((await api(A, "/api/club/check")).body.questions.length, 5);
let res = await api(A, "/api/club/check", "POST", { answers: [0, 0, 0, 0, 0] });
assert.equal(res.body.level, "green");
assert.equal(res.body.sentToTelegram, true);
assert.equal(photos(501).pop().body.photo, "https://srv.dev/cards/check-green.png");
res = await api(A, "/api/club/check", "POST", { answers: [2, 2, 2, 2, 1] });
assert.equal(res.body.level, "red");
assert.equal(res.body.sentToTelegram, false, "карточка не чаще раза в час");

// 3. Турнир
const wk = weekInfo();
fake = wk.start + 10 * 60 + 5; // 10-я минута недели
let t = await api(A, "/api/club/tour");
assert.equal(t.status, 200);
assert.equal(t.body.closedIndex, 9);
assert.equal(t.body.firstIndex + t.body.candles.length - 1, 9, "будущие свечи не отдаются");
assert.equal(t.body.me.bal, 1000);
assert.equal((await api(A, "/api/club/tour/trade", "POST", { dir: "up", amt: 5000, exp: 1 })).body.error, "no_balance");
assert.equal((await api(A, "/api/club/tour/trade", "POST", { dir: "up", amt: 10, exp: 2 })).body.error, "bad_trade");
t = await api(A, "/api/club/tour/trade", "POST", { dir: "up", amt: 100, exp: 1 });
assert.equal(t.body.me.bal, 900);
await api(A, "/api/club/tour/trade", "POST", { dir: "down", amt: 50, exp: 3 });
await api(A, "/api/club/tour/trade", "POST", { dir: "up", amt: 50, exp: 5 });
assert.equal((await api(A, "/api/club/tour/trade", "POST", { dir: "up", amt: 10, exp: 1 })).body.error, "too_many_open");
await api(B, "/api/club/tour/trade", "POST", { dir: "down", amt: 200, exp: 1 });
// через 6 минут все сделки закрыты
fake += 6 * 60;
t = await api(A, "/api/club/tour");
const me = t.body.me;
assert.equal(me.open.length, 0);
assert.equal(me.wins + me.losses + me.draws, 3);
const expected = 800 + me.last.reduce((s, x) => s + (x.res === "win" ? x.amt * 1.85 : x.res === "draw" ? x.amt : 0), 0);
assert.equal(me.bal, Math.round(expected * 100) / 100, "баланс посчитан сервером верно");
for (const x of me.last) {
  if (x.res !== "draw") assert.equal(x.res === "win", (x.close > x.entry) === (x.dir === "up"));
}
// одинаковый график у всех участников
const tb = await api(B, "/api/club/tour");
assert.deepEqual(tb.body.candles, t.body.candles);
assert.equal(tb.body.players, 2);
assert.ok(tb.body.top.some((x) => x.me));

// 4. Итоги недели в воскресенье
fake = wk.end + 60;
calls.length = 0;
let waited;
await worker.scheduled({}, env, { waitUntil: (p) => { waited = p; } });
await waited;
const cardsA = photos(501), cardsB = photos(502);
assert.equal(cardsA.length + cardsB.length, 2);
const places = [cardsA[0], cardsB[0]].map((c) => c.body.photo.split("/").pop()).sort();
assert.deepEqual(places, ["tour-1.png", "tour-2.png"]);
assert.ok(calls.some((c) => c.method === "sendMessage" && c.body.chat_id === "111" && c.body.text.includes("итоги недели")));
// повторно не рассылается
calls.length = 0;
await worker.scheduled({}, env, { waitUntil: (p) => { waited = p; } });
await waited;
assert.equal(calls.filter((c) => c.method === "sendPhoto").length, 0);
fake = null;

// 5. Дуэль
let d = await api(A, "/api/club/duel", "POST");
const duelId = d.body.id;
assert.match(duelId, /^[0-9a-f]{12}$/);
assert.equal(d.body.candles.length, 30, "до первого ответа видна только история");
let v = await api(B, "/api/club/duel/" + duelId);
assert.equal(v.body.joinable, true);
await api(B, "/api/club/duel/" + duelId + "/join", "POST");
assert.ok(calls.some((c) => c.method === "sendMessage" && c.body.chat_id === 501 && c.body.text.includes("принял")));
// третий не может войти
const C = await member("10000003", 503, "Вера");
assert.equal((await api(C, "/api/club/duel/" + duelId + "/join", "POST")).status, 409);
for (let i = 0; i < 10; i++) {
  d = await api(A, "/api/club/duel/" + duelId + "/guess", "POST", { dir: "up" });
  assert.equal(d.body.candles.length, 31 + i, "открывается ровно одна новая свеча");
}
assert.equal(d.body.me.done, true);
assert.equal(d.body.status, "playing");
assert.equal(d.body.opponent.score, null, "счёт соперника скрыт до конца");
for (let i = 0; i < 10; i++) await api(B, "/api/club/duel/" + duelId + "/guess", "POST", { dir: "down" });
d = await api(A, "/api/club/duel/" + duelId);
assert.equal(d.body.status, "done");
const sa = d.body.me.score, sb = d.body.opponent.score;
const ca = photos(501).pop().body.photo.split("/").pop();
const cb = photos(502).pop().body.photo.split("/").pop();
if (sa === sb) assert.deepEqual([ca, cb], ["duel-draw.png", "duel-draw.png"]);
else if (sa > sb) assert.deepEqual([ca, cb], ["duel-win.png", "duel-lose.png"]);
else assert.deepEqual([ca, cb], ["duel-lose.png", "duel-win.png"]);
assert.equal(sa + sb, 10, "вверх + вниз на одном графике = 10 (равенство считается «вверх»)");

console.log("Клуб: все проверки пройдены ✅ (дуэль " + sa + ":" + sb + ")");
