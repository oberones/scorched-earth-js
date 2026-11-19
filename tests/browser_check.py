"""Browser smoke test: python3 tests/browser_check.py  (needs Playwright + Chromium)
Loads dist/index.html, captures console errors, plays a human turn with the keyboard,
lets AIs play, and saves screenshots to tests/shots/."""
import os, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "tests", "shots")
os.makedirs(SHOTS, exist_ok=True)
URL = "file://" + os.path.join(ROOT, "dist", "index.html")

errors = []
with sync_playwright() as p:
    exe = os.environ.get("CHROME")
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 810})
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{SHOTS}/1_setup.png")

    pg.click("#start")
    pg.wait_for_timeout(300)
    pg.screenshot(path=f"{SHOTS}/2_shop.png")
    # buy a couple of things then start
    for name in ("Baby Nuke", "Fuel"):
        pg.locator(".card", has_text=name).first.locator("button.buy").click()
    pg.click("#shop-done")
    pg.wait_for_timeout(500)

    # wait for the human's turn, aim with keys, fire
    fired = 0
    t0 = time.time()
    while time.time() - t0 < 90 and fired < 2:
        st = pg.evaluate("(() => { const g = window.__scorched.game; return { phase: g.phase, human: g.current.type === 'human' }; })()")
        if st["phase"] == "aim" and st["human"]:
            if fired == 0:
                before = pg.evaluate("(() => { const t = window.__scorched.game.current; return { x: t.x, fuel: t.items.fuel }; })()")
                pg.keyboard.press("f")
                pg.keyboard.down("ArrowRight"); pg.wait_for_timeout(350); pg.keyboard.up("ArrowRight")
                pg.keyboard.press("Escape")
                moved = pg.evaluate("(() => { const t = window.__scorched.game.current; return { x: t.x, fuel: t.items.fuel }; })()")
                if moved["x"] == before["x"]:
                    pg.keyboard.press("f")
                    pg.keyboard.down("ArrowLeft"); pg.wait_for_timeout(350); pg.keyboard.up("ArrowLeft")
                    pg.keyboard.press("Escape")
                    moved = pg.evaluate("(() => { const t = window.__scorched.game.current; return { x: t.x, fuel: t.items.fuel }; })()")
                assert moved["x"] != before["x"] and moved["fuel"] < before["fuel"], "tank did not spend fuel to move"
            pg.keyboard.down("ArrowUp"); pg.wait_for_timeout(400); pg.keyboard.up("ArrowUp")
            pg.keyboard.down("ArrowLeft"); pg.wait_for_timeout(200); pg.keyboard.up("ArrowLeft")
            pg.keyboard.press("e")
            pg.screenshot(path=f"{SHOTS}/3_aim.png")
            pg.keyboard.press("Space")
            fired += 1
            pg.wait_for_timeout(700)
            pg.screenshot(path=f"{SHOTS}/4_flight_{fired}.png")
        elif st["phase"] in ("roundOver",):
            break
        pg.wait_for_timeout(150)
    print("human shots fired:", fired)

    # grab an explosion frame from the AI
    for i in range(60):
        n = pg.evaluate("window.__scorched.game.blasts.length")
        if n:
            pg.screenshot(path=f"{SHOTS}/5_explosion.png"); break
        pg.wait_for_timeout(100)

    # let the AI finish: kill the human to speed things up, then play to round over
    pg.evaluate("(() => { const g = window.__scorched.game; const h = g.tanks.find(t => t.type === 'human'); if (h.alive) { h.health = 1; } })()")
    pg.click("#btn-speed"); pg.click("#btn-speed")  # 4x
    t0 = time.time()
    while time.time() - t0 < 180:
        vis = pg.evaluate("!document.querySelector('#screen-round').hidden")
        st = pg.evaluate("(() => { const g = window.__scorched.game; return { phase: g.phase, human: g.current.type === 'human' }; })()")
        if st["phase"] == "aim" and st["human"]:
            pg.keyboard.press("Space")
        if vis:
            break
        pg.wait_for_timeout(200)
    pg.screenshot(path=f"{SHOTS}/6_round_over.png")
    print("round summary shown:", vis)
    pg.click("#round-next")
    pg.wait_for_timeout(300)
    shop = pg.evaluate("!document.querySelector('#screen-shop').hidden")
    print("shop shown for round 2:", shop)
    b.close()

print("console errors:", errors or "none")
sys.exit(1 if errors else 0)
