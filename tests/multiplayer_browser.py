"""Two real browsers play an online game against each other through the server.
python3 tests/multiplayer_browser.py   (needs Playwright + Chromium)"""
import os, subprocess, sys, time, random
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "tests", "shots"); os.makedirs(SHOTS, exist_ok=True)
PORT = 19000 + random.randint(0, 900)
env = dict(os.environ, PORT=str(PORT), LOG_LEVEL="quiet", COUNTDOWN_MS="1500", ROUND_PAUSE_MS="4000")
srv = subprocess.Popen(["node", os.path.join(ROOT, "server", "server.js")], env=env)
time.sleep(0.8)
URL = f"http://127.0.0.1:{PORT}/"
errors = []
def wait_until(pg, expr, timeout=10000):
    """Poll with page.evaluate (CDP), which the strict CSP allows; wait_for_function needs eval."""
    end = time.time() + timeout / 1000
    while time.time() < end:
        if pg.evaluate(expr): return
        pg.wait_for_timeout(100)
    raise TimeoutError(expr)

STATE = "(() => { const g = window.__scorched.Net.game; if (!g) return null; return { stage: g.stage, phase: g.phase, mine: g.canControl(g.me), round: g.round }; })()"

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pages = []
        for name in ("Alice", "Bob"):
            ctx = b.new_context(viewport={"width": 1280, "height": 760})
            pg = ctx.new_page()
            pg.on("console", lambda m, n=name: m.type == "error" and errors.append(f"{n}: {m.text}"))
            pg.on("console", lambda m, n=name: "Content Security Policy" in m.text and errors.append(f"{n} CSP: {m.text}"))
            pg.on("pageerror", lambda e, n=name: errors.append(f"{n}: {e}"))
            pg.goto(URL); pg.wait_for_timeout(600)
            pg.click("#btn-online")
            pg.fill("#net-name", name); pg.press("#net-name", "Tab")
            pages.append(pg)
        A, B = pages
        A.wait_for_selector("#net-status.ok")
        A.fill("#new-room-name", "Friday Night Artillery"); A.click("#create-room")
        A.wait_for_selector("#screen-room:not([hidden])")
        code = A.inner_text("#room-code")
        B.wait_for_selector(f".room-row .join[data-code='{code}']")
        B.screenshot(path=f"{SHOTS}/mp1_lobby_list.png")
        B.click(f".room-row .join[data-code='{code}']")
        B.wait_for_selector("#screen-room:not([hidden])")
        A.select_option("#bot-diff", "hard"); A.click("#add-bot")
        A.select_option("#rs-rounds", "1"); A.select_option("#rs-turnTime", "20")
        A.fill("#chat-input", "Good luck, Bob!"); A.press("#chat-input", "Enter")
        B.wait_for_selector("#chat-log .cl >> text=Good luck")
        A.click("#vote-btn")
        B.wait_for_timeout(400)
        B.screenshot(path=f"{SHOTS}/mp2_room.png")
        assert B.locator(".member .vote.yes").count() >= 1
        B.click("#vote-btn")
        A.wait_for_selector("#screen-shop:not([hidden])", timeout=10000)
        A.screenshot(path=f"{SHOTS}/mp3_shop.png")
        A.locator(".card", has_text="Missile").first.locator("button.buy").click()
        A.locator(".card", has_text="Fuel").first.locator("button.buy").click()
        wait_until(A, "window.__scorched.Net.game.me.inventory.missile === 5", 5000)
        wait_until(A, "window.__scorched.Net.game.me.items.fuel === 50", 5000)
        A.click("#shop-done")
        A.wait_for_selector("#screen-wait:not([hidden])")
        B.click("#shop-done")
        wait_until(A, "!!window.__scorched.Net.game && window.__scorched.Net.game.stage === 'play'", 10000)

        shots = {"Alice": 0, "Bob": 0}
        captured = set()
        t0 = time.time()
        while time.time() - t0 < 240:
            done = False
            for name, pg in (("Alice", A), ("Bob", B)):
                st = pg.evaluate(STATE)
                if st and st["mine"]:
                    if name == "Alice" and shots["Alice"] == 0:
                        before = pg.evaluate("(() => { const t = window.__scorched.Net.game.me; return { x: t.x, fuel: t.items.fuel }; })()")
                        pg.keyboard.press("f")
                        pg.keyboard.down("ArrowRight"); pg.wait_for_timeout(450); pg.keyboard.up("ArrowRight")
                        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
                        moved = pg.evaluate("(() => { const t = window.__scorched.Net.game.me; return { x: t.x, fuel: t.items.fuel }; })()")
                        assert moved["x"] != before["x"] and moved["fuel"] < before["fuel"], "online movement was not confirmed"
                    pg.keyboard.down("ArrowUp"); pg.wait_for_timeout(250); pg.keyboard.up("ArrowUp")
                    if name == "Alice" and shots["Alice"] == 0: pg.keyboard.press("e")  # missile
                    if "aim" not in captured:
                        other = B if pg is A else A
                        other.wait_for_timeout(300)
                        other.screenshot(path=f"{SHOTS}/mp4_watching_opponent_aim.png"); captured.add("aim")
                    pg.keyboard.press("Space"); shots[name] += 1
                    if "flight" not in captured:
                        pg.wait_for_timeout(600); pg.screenshot(path=f"{SHOTS}/mp5_flight.png"); captured.add("flight")
                if not pg.locator("#screen-over").is_hidden():
                    done = True
            if "blast" not in captured and B.evaluate("(window.__scorched.Net.game||{blasts:[]}).blasts.length > 0"):
                B.screenshot(path=f"{SHOTS}/mp6_blast_seen_by_bob.png"); captured.add("blast")
            if done: break
            A.wait_for_timeout(150)
        print("shots fired:", shots)
        A.wait_for_selector("#screen-over:not([hidden])", timeout=30000)
        A.screenshot(path=f"{SHOTS}/mp7_game_over.png")
        # both clients agree on the final scores
        sa = A.evaluate("window.__scorched.Net.game.tanks.map(t => t.score)")
        sb = B.evaluate("window.__scorched.Net.game.tanks.map(t => t.score)")
        print("scores A:", sa, "B:", sb)
        assert sa == sb, "clients disagree on scores"
        A.click("#over-again")
        A.wait_for_selector("#screen-room:not([hidden])")
        assert A.inner_text("#vote-btn").lower() == "vote to start"
        print("back in room, votes reset")
        b.close()
finally:
    srv.terminate()
print("console errors:", errors or "none")
sys.exit(1 if errors else 0)
