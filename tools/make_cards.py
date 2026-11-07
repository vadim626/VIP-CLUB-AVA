"""
Рисует картинки-карточки, которые бот присылает участникам.
Запуск: python3 tools/make_cards.py  → файлы появятся в папке cards/
"""
import math
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "cards"
OUT.mkdir(exist_ok=True)
W = H = 1080
F = "/usr/share/fonts/opentype/inter/"


def font(weight, size):
    return ImageFont.truetype(F + {"black": "Inter-Black.otf", "bold": "Inter-Bold.otf",
                                   "semi": "Inter-SemiBold.otf", "med": "Inter-Medium.otf"}[weight], size)


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def background(accent):
    img = Image.new("RGB", (W, H), (7, 4, 16))
    # мягкое свечение
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    a = hexrgb(accent)
    g.ellipse((W * 0.15, -H * 0.25, W * 0.85, H * 0.55), fill=a)
    g.ellipse((-W * 0.3, H * 0.65, W * 0.4, H * 1.3), fill=(110, 0, 255))
    glow = glow.filter(ImageFilter.GaussianBlur(170))
    img = Image.blend(img, glow, 0.55)
    d = ImageDraw.Draw(img)
    # декоративные свечи внизу
    rnd = random.Random(accent)
    x, p = 40, 935
    while x < W - 30:
        o = p
        c = p + rnd.uniform(-22, 20)
        hi, lo = min(o, c) - rnd.uniform(4, 16), max(o, c) + rnd.uniform(4, 16)
        col = (43, 182, 115) if c < o else (242, 73, 92)
        col = tuple(int(v * 0.42) for v in col)
        d.line((x + 9, hi, x + 9, lo), fill=col, width=3)
        d.rounded_rectangle((x, min(o, c), x + 18, max(max(o, c), min(o, c) + 3)), 3, fill=col)
        p = min(max(c, 885), 975)
        x += 30
    # рамка
    d.rounded_rectangle((28, 28, W - 28, H - 28), 48, outline=(255, 255, 255, 40), width=2)
    return img


def brand(d):
    d.rounded_rectangle((W / 2 - 150, 78, W / 2 + 150, 132), 27, fill=(40, 16, 70), outline=(150, 80, 255), width=2)
    d.ellipse((W / 2 - 122, 99, W / 2 - 110, 111), fill=(48, 209, 88))
    d.text((W / 2 + 12, 105), "AVA  TRADE", font=font("bold", 30), fill=(222, 190, 255), anchor="mm")


def centered(d, y, text, f, fill):
    d.text((W / 2, y), text, font=f, fill=fill, anchor="mm")


def badge(img, accent, draw_icon):
    # круглый значок с иконкой
    d = ImageDraw.Draw(img)
    cx, cy, r = W / 2, 330, 130
    halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse((cx - r - 40, cy - r - 40, cx + r + 40, cy + r + 40), fill=hexrgb(accent) + (120,))
    halo = halo.filter(ImageFilter.GaussianBlur(40))
    img.paste(halo, (0, 0), halo)
    d = ImageDraw.Draw(img)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=hexrgb(accent))
    d.ellipse((cx - r + 10, cy - r + 10, cx + r - 10, cy + r - 10), outline=(255, 255, 255), width=4)
    draw_icon(d, cx, cy)
    return d


def icon_check(d, cx, cy):
    d.line((cx - 55, cy + 2, cx - 15, cy + 45, cx + 60, cy - 45), fill="white", width=26, joint="curve")


def icon_warn(d, cx, cy):
    d.rounded_rectangle((cx - 13, cy - 70, cx + 13, cy + 22), 12, fill="white")
    d.ellipse((cx - 16, cy + 40, cx + 16, cy + 72), fill="white")


def icon_pause(d, cx, cy):
    d.rounded_rectangle((cx - 48, cy - 58, cx - 14, cy + 58), 10, fill="white")
    d.rounded_rectangle((cx + 14, cy - 58, cx + 48, cy + 58), 10, fill="white")


def icon_cup(text):
    def draw(d, cx, cy):
        d.rounded_rectangle((cx - 62, cy - 70, cx + 62, cy + 10), 30, fill="white")
        d.arc((cx - 98, cy - 60, cx - 38, cy - 5), 90, 270, fill="white", width=12)
        d.arc((cx + 38, cy - 60, cx + 98, cy - 5), 270, 90, fill="white", width=12)
        d.rectangle((cx - 12, cy + 5, cx + 12, cy + 40), fill="white")
        d.rounded_rectangle((cx - 52, cy + 38, cx + 52, cy + 62), 8, fill="white")
        if text:
            d.text((cx, cy - 32), text, font=font("black", 62), fill=(70, 40, 10), anchor="mm")
    return draw


def icon_swords(d, cx, cy):
    for s in (1, -1):
        d.line((cx - 60 * s, cy - 60, cx + 52 * s, cy + 52), fill="white", width=18)
        d.line((cx + 30 * s, cy + 58, cx + 58 * s, cy + 30), fill="white", width=14)
        d.ellipse((cx + 52 * s - 10, cy + 52 - 10, cx + 52 * s + 10, cy + 52 + 10), fill="white")


def icon_handshake(d, cx, cy):
    d.rounded_rectangle((cx - 58, cy - 36, cx + 58, cy - 12), 10, fill="white")
    d.rounded_rectangle((cx - 58, cy + 12, cx + 58, cy + 36), 10, fill="white")


def card(name, accent, icon, eyebrow, title, subtitle, foot="Trading Academy · VIP CLUB"):
    img = background(accent)
    d = badge(img, accent, icon)
    brand(d)
    centered(d, 520, eyebrow, font("bold", 34), hexrgb(accent))
    size = 92 if len(title) <= 11 else 82 if len(title) <= 14 else 70 if len(title) <= 18 else 60
    centered(d, 610, title, font("black", size), (255, 255, 255))
    y = 700
    for line in subtitle.split("\n"):
        centered(d, y, line, font("med", 38), (215, 205, 235))
        y += 52
    centered(d, H - 70, foot, font("semi", 26), (150, 130, 190))
    img.save(OUT / (name + ".png"), optimize=True)


card("check-green", "#2bb673", icon_check, "ПРОВЕРКА ПЕРЕД ТОРГОВЛЕЙ", "ТОРГУЙ ПО ПЛАНУ",
     "Ты в форме. Соблюдай риск 1–2%\nи стоп после 3 убытков подряд.")
card("check-yellow", "#f5b83d", icon_warn, "ПРОВЕРКА ПЕРЕД ТОРГОВЛЕЙ", "ОСТОРОЖНО",
     "Сегодня — только маленькие суммы\nи только лучшие сигналы.")
card("check-red", "#f2495c", icon_pause, "ПРОВЕРКА ПЕРЕД ТОРГОВЛЕЙ", "СЕГОДНЯ ПАУЗА",
     "Лучшая сделка сегодня — пропущенная.\nДепозит скажет спасибо.")
card("tour-1", "#f5b83d", icon_cup("1"), "ТУРНИР AVA · ИТОГИ НЕДЕЛИ", "1 МЕСТО", "Чемпион недели!\nЛучший результат в клубе.")
card("tour-2", "#c9d1e0", icon_cup("2"), "ТУРНИР AVA · ИТОГИ НЕДЕЛИ", "2 МЕСТО", "Серебро недели!\nДо золота — один шаг.")
card("tour-3", "#d08a4a", icon_cup("3"), "ТУРНИР AVA · ИТОГИ НЕДЕЛИ", "3 МЕСТО", "Бронза недели!\nТы в тройке лучших.")
card("tour-top", "#a020ff", icon_cup(""), "ТУРНИР AVA · ИТОГИ НЕДЕЛИ", "НЕДЕЛЯ ЗАВЕРШЕНА", "Новый турнир уже начался.\nБаланс снова $1 000.")
card("duel-win", "#2bb673", icon_swords, "ДУЭЛЬ AVA", "ПОБЕДА!", "Ты прочитал рынок лучше соперника.")
card("duel-lose", "#f2495c", icon_swords, "ДУЭЛЬ AVA", "ПОРАЖЕНИЕ", "Соперник оказался точнее.\nРеванш?")
card("duel-draw", "#4a8cff", icon_handshake, "ДУЭЛЬ AVA", "НИЧЬЯ", "Равный бой.\nКто возьмёт реванш?")
card("duel-call", "#a020ff", icon_swords, "ДУЭЛЬ AVA", "ТЕБЯ ВЫЗВАЛИ!", "10 свечей. Кто угадает больше?")
print("готово:", sorted(p.name for p in OUT.glob("*.png")))
