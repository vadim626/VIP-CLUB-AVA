/**
 * AVA TRADE — клубные функции для одобренных участников:
 *   🧠 «Можно ли мне сегодня торговать?»
 *   🏆 Еженедельный турнир (симулятор, у всех один график)
 *   ⚔️ Дуэли 1 на 1 (10 свечей, кто угадает больше)
 *
 * Честность: свечи турнира и дуэлей генерирует СЕРВЕР по секретному ключу,
 * будущие свечи посетителю не отдаются, результаты сделок считает сервер.
 * Это симуляция для тренировки — реальных денег здесь нет.
 */

const MIN = 60;
const LOCAL_OFFSET = 6 * 3600;          // неделя турнира — по времени Бишкека (UTC+6)
const START_BALANCE = 1000;
const PAYOUT = 0.85;
const MAX_OPEN = 3;
const EXPIRIES = [1, 3, 5];             // свечей (минут)
const SHOW_CANDLES = 70;
const DUEL_ROUNDS = 10;
const DUEL_HISTORY = 30;
const DUEL_TTL = 60 * 60 * 24 * 7;
const KV_TTL = 60 * 60 * 24 * 21;

/* ============================================================
   Общие помощники
   ============================================================ */

export function memberId(record) {
  return record.tg && record.tg.id ? "t" + record.tg.id : "r" + record.reqId;
}

export function memberName(record) {
  const first = record.tg && record.tg.name ? record.tg.name.split(" ")[0] : "";
  const base = first || (record.tg && record.tg.username) || "Трейдер";
  return (base.slice(0, 16) + " ·" + String(record.pocketId).slice(-2)).trim();
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function rng(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedFrom(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new DataView(buf).getInt32(0);
}

const r5 = (x) => Math.round(x * 1e5) / 1e5;

// Реалистичное движение: тренды и боковики сменяют друг друга, волатильность «дышит».
function series(seed, n, start = 1.0850) {
  const r = rng(seed);
  const out = [];
  let p = start, drift = 0, vol = 0.00035, left = 0;
  for (let i = 0; i < n; i++) {
    if (left <= 0) {
      left = 20 + Math.floor(r() * 70);
      const mode = r();
      drift = mode < 0.35 ? 0 : (r() < 0.5 ? -1 : 1) * (0.00004 + r() * 0.00012);
      vol = 0.00022 + r() * 0.00035;
    }
    left--;
    const pull = (1.0850 - p) * 0.004; // мягко держим цену в разумных пределах
    const o = p;
    const c = o + drift + pull + (r() - 0.5) * 2 * vol;
    const h = Math.max(o, c) + r() * vol * 0.8;
    const l = Math.min(o, c) - r() * vol * 0.8;
    out.push([r5(o), r5(h), r5(l), r5(c)]);
    p = c;
  }
  return out;
}

async function getJSON(env, key) {
  const raw = await env.AVA_KV.get(key);
  return raw ? JSON.parse(raw) : null;
}

function putJSON(env, key, val, ttl = KV_TTL) {
  return env.AVA_KV.put(key, JSON.stringify(val), { expirationTtl: ttl });
}

async function sendCard(env, ctx, chatId, card, caption, buttons) {
  if (!chatId) return { ok: false };
  return ctx.telegram(env, "sendPhoto", {
    chat_id: chatId,
    photo: ctx.cardsUrl(env) + "/" + card + ".png",
    caption,
    parse_mode: "HTML",
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

function esc(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ============================================================
   🧠 Проверка перед торговлей
   ============================================================ */

const CHECK_QUESTIONS = [
  { q: "Как ты спал?", a: [["Выспался", 0], ["Так себе", 1], ["Плохо, не выспался", 2]] },
  { q: "Какое сейчас настроение?", a: [["Спокоен", 0], ["Немного нервничаю", 1], ["Злюсь или азарт", 2]] },
  { q: "Как прошла прошлая торговля?", a: [["В плюс или без сделок", 0], ["Небольшой минус", 1], ["Большой минус, хочу отыграться", 3]] },
  { q: "Есть план на сегодня (пары, время, лимит)?", a: [["Да, записан", 0], ["Примерно в голове", 1], ["Нет", 2]] },
  { q: "Какими деньгами торгуешь?", a: [["Свободными, потеря не страшна", 0], ["Эти деньги мне нужны", 3]] },
];

const CHECK_TIPS = [
  ["", "Недосып снижает внимание — сократи время торговли.", "Без сна мозг принимает импульсивные решения. Отдохни."],
  ["", "Сделай 5 медленных вдохов перед первой сделкой.", "Злость и азарт — главные причины слива депозита."],
  ["", "Не увеличивай ставку, чтобы вернуть минус.", "Желание отыграться — это тильт. Сегодня лучше пауза."],
  ["", "Запиши 3 правила на сегодня: пары, время, лимит убытка.", "Без плана торговля превращается в лотерею. Составь план."],
  ["", "", "Торгуй только деньгами, потерю которых можешь позволить."],
];

export function checkQuestions() {
  return CHECK_QUESTIONS.map((x) => ({ q: x.q, a: x.a.map((a) => a[0]) }));
}

export function evaluateCheck(answers) {
  if (!Array.isArray(answers) || answers.length !== CHECK_QUESTIONS.length) return null;
  let score = 0, hard = false;
  const tips = [];
  for (let i = 0; i < answers.length; i++) {
    const k = answers[i];
    const opt = CHECK_QUESTIONS[i].a[k];
    if (!Number.isInteger(k) || !opt) return null;
    score += opt[1];
    if (opt[1] >= 3) hard = true;
    const tip = CHECK_TIPS[i][Math.min(opt[1], 2)] || (opt[1] >= 3 ? CHECK_TIPS[i][2] : "");
    if (tip) tips.push(tip);
  }
  const level = hard || score >= 4 ? "red" : score >= 2 ? "yellow" : "green";
  return { level, score, tips };
}

const CHECK_TEXT = {
  green: "🟢 <b>Можно торговать по плану</b>\nРиск 1–2% на сделку, стоп после 3 убытков подряд.",
  yellow: "🟡 <b>Осторожно</b>\nТолько маленькие суммы и только сигналы, где совпадают 2–3 фактора.",
  red: "🔴 <b>Сегодня лучше пауза</b>\nЛучшая сделка сегодня — пропущенная. Можно потренироваться в турнире AVA.",
};

export async function handleCheckin(request, env, ctx, record) {
  let body;
  try { body = await request.json(); } catch { return { status: 400, body: { error: "bad_request" } }; }
  const res = evaluateCheck(body && body.answers);
  if (!res) return { status: 400, body: { error: "bad_answers" } };

  // Карточку в Telegram — не чаще раза в час
  let sent = false;
  const key = "chk:" + memberId(record);
  const last = Number((await env.AVA_KV.get(key)) || 0);
  if (record.tg && record.tg.id && now() - last > 3600) {
    const caption = CHECK_TEXT[res.level] + (res.tips.length ? "\n\n" + res.tips.map((t) => "• " + esc(t)).join("\n") : "");
    const r = await sendCard(env, ctx, record.tg.id, "check-" + res.level, caption);
    sent = Boolean(r.ok);
    if (sent) await env.AVA_KV.put(key, String(now()), { expirationTtl: 7200 });
  }
  return { status: 200, body: { ...res, sentToTelegram: sent } };
}

/* ============================================================
   🏆 Турнир недели
   ============================================================ */

export function weekInfo(t = now()) {
  const day = Math.floor((t + LOCAL_OFFSET) / 86400);
  const weekday = (day + 3) % 7; // 0 = понедельник (1970-01-01 был четвергом)
  const startDay = day - weekday;
  const start = startDay * 86400 - LOCAL_OFFSET;
  return { id: startDay, start, end: start + 7 * 86400 };
}

async function tourSeries(env, week, upto) {
  const seed = await seedFrom((env.WEBHOOK_SECRET || "ava") + ":tour:" + week.id);
  return series(seed, upto + 1);
}

function tourIndex(week, t = now()) {
  return Math.floor((t - week.start) / MIN); // номер текущей (ещё не закрытой) свечи
}

async function tourPlayer(env, week, record) {
  const key = "tp:" + week.id + ":" + memberId(record);
  const p = (await getJSON(env, key)) || {
    mid: memberId(record), name: memberName(record), tgId: record.tg ? record.tg.id : null,
    bal: START_BALANCE, open: [], wins: 0, losses: 0, draws: 0, last: [],
  };
  return { key, p };
}

// Закрывает истёкшие сделки игрока. closed — номер последней закрытой свечи.
function settle(p, cs, closed) {
  let changed = false;
  p.open = p.open.filter((t) => {
    const x = t.at + t.exp;
    if (x > closed) return true;
    const close = cs[x][3];
    let res;
    if (close === t.entry) { p.bal += t.amt; p.draws++; res = "draw"; }
    else if ((close > t.entry) === (t.dir === "up")) { p.bal += t.amt * (1 + PAYOUT); p.wins++; res = "win"; }
    else { p.losses++; res = "loss"; }
    p.bal = Math.round(p.bal * 100) / 100;
    p.last.unshift({ dir: t.dir, amt: t.amt, res, entry: t.entry, close });
    p.last = p.last.slice(0, 8);
    changed = true;
    return false;
  });
  return changed;
}

async function updateBoard(env, week, p) {
  const key = "tlb:" + week.id;
  const lb = (await getJSON(env, key)) || {};
  // «Баланс» в таблице = свободные средства + деньги в открытых сделках
  const inTrades = p.open.reduce((sum, t) => sum + t.amt, 0);
  lb[p.mid] = { name: p.name, bal: Math.round((p.bal + inTrades) * 100) / 100, n: p.wins + p.losses + p.draws + p.open.length, tgId: p.tgId };
  await putJSON(env, key, lb);
  return lb;
}

function ranking(lb) {
  return Object.entries(lb)
    .map(([mid, v]) => ({ mid, ...v }))
    .filter((v) => v.n > 0)
    .sort((a, b) => b.bal - a.bal || b.n - a.n);
}

export async function handleTour(request, env, ctx, record, action) {
  const week = weekInfo();
  const idx = tourIndex(week);
  const closed = idx - 1;
  if (closed < 1) {
    return { status: 200, body: { starting: true, startsIn: week.start + 2 * MIN - now() } };
  }
  const cs = await tourSeries(env, week, idx);
  const { key, p } = await tourPlayer(env, week, record);
  const settled = settle(p, cs, closed);

  if (action === "trade") {
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const dir = body.dir === "up" || body.dir === "down" ? body.dir : null;
    const exp = EXPIRIES.includes(Number(body.exp)) ? Number(body.exp) : null;
    const amt = Math.floor(Number(body.amt));
    if (!dir || !exp || !(amt >= 1)) return { status: 400, body: { error: "bad_trade" } };
    if (amt > p.bal) return { status: 400, body: { error: "no_balance" } };
    if (p.open.length >= MAX_OPEN) return { status: 400, body: { error: "too_many_open" } };
    if (week.start + (closed + exp + 1) * MIN > week.end) return { status: 400, body: { error: "week_ending" } };
    p.open.push({ at: closed, exp, dir, amt, entry: cs[closed][3] });
    p.bal = Math.round((p.bal - amt) * 100) / 100;
  }

  let lb;
  if (settled || action === "trade") {
    await putJSON(env, key, p);
    lb = await updateBoard(env, week, p);
  } else {
    lb = (await getJSON(env, "tlb:" + week.id)) || {};
  }
  const rank = ranking(lb);
  const myPlace = rank.findIndex((v) => v.mid === p.mid) + 1;

  return {
    status: 200,
    body: {
      asset: "AVA/USD",
      payout: PAYOUT,
      expiries: EXPIRIES,
      candles: cs.slice(Math.max(0, closed - SHOW_CANDLES + 1), closed + 1),
      firstIndex: Math.max(0, closed - SHOW_CANDLES + 1),
      closedIndex: closed,
      nextCandleIn: week.start + (idx + 1) * MIN - now(),
      weekEndsIn: week.end - now(),
      me: { name: p.name, bal: p.bal, open: p.open, wins: p.wins, losses: p.losses, draws: p.draws, last: p.last, place: myPlace || null },
      top: rank.slice(0, 10).map((v, i) => ({ place: i + 1, name: v.name, bal: v.bal, n: v.n, me: v.mid === p.mid })),
      players: rank.length,
    },
  };
}

// Воскресенье, 18:00 UTC (00:00 по Бишкеку) — итоги недели и карточки участникам.
export async function finishWeek(env, ctx) {
  const ended = weekInfo(now() - 3600);
  if (await env.AVA_KV.get("tdone:" + ended.id)) return { already: true };
  const lb = (await getJSON(env, "tlb:" + ended.id)) || {};
  const rank = ranking(lb);
  const total = rank.length;
  for (let i = 0; i < rank.length; i++) {
    const v = rank[i];
    if (!v.tgId) continue;
    const place = i + 1;
    const card = place <= 3 ? "tour-" + place : "tour-top";
    const caption =
      "🏆 <b>Итоги турнира AVA</b>\n\n" +
      "Твоё место: <b>" + place + " из " + total + "</b>\n" +
      "Итоговый баланс: <b>$" + v.bal.toFixed(2) + "</b> (старт $" + START_BALANCE + ")\n" +
      "Сделок за неделю: " + v.n + "\n\nНовый турнир уже начался — баланс снова $" + START_BALANCE + ".";
    await sendCard(env, ctx, v.tgId, card, caption);
  }
  if (env.ADMIN_CHAT_ID && total) {
    const lines = rank.slice(0, 10).map((v, i) => (i + 1) + ". " + esc(v.name) + " — $" + v.bal.toFixed(2) + " (" + v.n + " сд.)");
    await ctx.telegram(env, "sendMessage", {
      chat_id: env.ADMIN_CHAT_ID,
      parse_mode: "HTML",
      text: "🏆 <b>Турнир AVA — итоги недели</b>\nУчастников: " + total + "\n\n" + lines.join("\n"),
    });
  }
  await env.AVA_KV.put("tdone:" + ended.id, "1", { expirationTtl: KV_TTL });
  return { sent: total };
}

/* ============================================================
   ⚔️ Дуэли
   ============================================================ */

function duelPublic(d, mid) {
  const me = d.players.find((x) => x.mid === mid);
  const opp = d.players.find((x) => x.mid !== mid);
  const step = me ? me.guesses.length : 0;
  const show = d.cs.slice(0, DUEL_HISTORY + step); // будущие свечи не отдаём
  return {
    id: d.id,
    status: d.status,
    rounds: DUEL_ROUNDS,
    candles: show,
    me: me ? { name: me.name, guesses: me.guesses, score: me.score, done: me.guesses.length >= DUEL_ROUNDS } : null,
    opponent: opp ? { name: opp.name, done: opp.guesses.length >= DUEL_ROUNDS, score: d.status === "done" ? opp.score : null } : null,
    joinable: !me && d.players.length < 2 && d.status !== "done",
    result: d.status === "done" ? d.result : null,
  };
}

export async function handleDuel(request, env, ctx, record, action, duelId) {
  const mid = memberId(record);

  if (action === "create") {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
    const seed = crypto.getRandomValues(new Int32Array(1))[0];
    const d = {
      id, seed, status: "open", createdAt: now(),
      cs: series(seed, DUEL_HISTORY + DUEL_ROUNDS, 1.0800 + (Math.abs(seed) % 200) / 10000),
      players: [{ mid, name: memberName(record), tgId: record.tg ? record.tg.id : null, guesses: [], score: 0 }],
    };
    await putJSON(env, "duel:" + id, d, DUEL_TTL);
    return { status: 200, body: duelPublic(d, mid) };
  }

  if (!/^[0-9a-f]{12}$/.test(duelId || "")) return { status: 404, body: { error: "not_found" } };
  const d = await getJSON(env, "duel:" + duelId);
  if (!d) return { status: 404, body: { error: "not_found" } };

  if (action === "join") {
    if (!d.players.find((x) => x.mid === mid)) {
      if (d.players.length >= 2) return { status: 409, body: { error: "full" } };
      d.players.push({ mid, name: memberName(record), tgId: record.tg ? record.tg.id : null, guesses: [], score: 0 });
      d.status = "playing";
      await putJSON(env, "duel:" + d.id, d, DUEL_TTL);
      const host = d.players[0];
      if (host.tgId) {
        await ctx.telegram(env, "sendMessage", {
          chat_id: host.tgId,
          text: "⚔️ " + d.players[1].name + " принял твой вызов на дуэль! Результат придёт сюда, когда вы оба сыграете.",
        });
      }
    }
    return { status: 200, body: duelPublic(d, mid) };
  }

  if (action === "guess") {
    const me = d.players.find((x) => x.mid === mid);
    if (!me) return { status: 403, body: { error: "not_in_duel" } };
    if (me.guesses.length >= DUEL_ROUNDS) return { status: 200, body: duelPublic(d, mid) };
    let body;
    try { body = await request.json(); } catch { body = {}; }
    if (body.dir !== "up" && body.dir !== "down") return { status: 400, body: { error: "bad_guess" } };
    const k = DUEL_HISTORY + me.guesses.length;
    const ok = (d.cs[k][3] >= d.cs[k - 1][3]) === (body.dir === "up");
    me.guesses.push({ dir: body.dir, ok });
    if (ok) me.score++;

    const both = d.players.length === 2 && d.players.every((x) => x.guesses.length >= DUEL_ROUNDS);
    if (both && d.status !== "done") {
      const [a, b] = d.players;
      d.status = "done";
      d.result = a.score === b.score ? { draw: true } : { winner: a.score > b.score ? a.mid : b.mid };
      await putJSON(env, "duel:" + d.id, d, DUEL_TTL);
      for (const pl of d.players) {
        const other = d.players.find((x) => x !== pl);
        const card = d.result.draw ? "duel-draw" : d.result.winner === pl.mid ? "duel-win" : "duel-lose";
        await sendCard(env, ctx, pl.tgId, card,
          "⚔️ <b>Дуэль AVA</b>\n\n" + esc(pl.name) + " — <b>" + pl.score + "</b>\n" + esc(other.name) + " — <b>" + other.score + "</b>\n\n" +
          (d.result.draw ? "Ничья! Кто возьмёт реванш?" : d.result.winner === pl.mid ? "Победа! 🔥" : "В этот раз соперник точнее. Реванш?"));
      }
    } else {
      await putJSON(env, "duel:" + d.id, d, DUEL_TTL);
    }
    return { status: 200, body: duelPublic(d, mid) };
  }

  return { status: 200, body: duelPublic(d, mid) };
}
