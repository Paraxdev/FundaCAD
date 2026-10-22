// Two plates whose top faces are 0.1mm apart, a black one over a white one, in
// a scene a few metres across whose bounding box holds the eye, zoomed from
// 200mm to 1500mm in 2% steps. At every step the top plate is drawn alone and
// then with the white one under it; any pixel of the top plate that changes is
// the white face fighting through. ZF_CONTROL=1 sets only the union box, the
// way the rig was fed before it knew each body's box, and reports the fight.
// node e2e/coplanar_plates_e2e.cjs <outDir> [enginePort] [token] [vitePort]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const OUT = process.argv[2] || "coplanar_plates_out";
const PORT = process.argv[3] || "8791";
const TOKEN = process.argv[4] || "cptok";
const VITE = process.argv[5] || "5191";
const CONTROL = process.env.ZF_CONTROL === "1";
const GAP = 0.1;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const res = { steps: [], errors: [] };
  let failed = 0;
  const check = (name, ok, detail) => {
    res[name] = { ok, detail };
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name} ${JSON.stringify(detail)}`);
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.on("pageerror", (e) => res.errors.push(e.message));
    await page.addInitScript(
      ([port]) => {
        try {
          localStorage.removeItem("fundacad.render");
        } catch {
          /* fresh profile */
        }
        const N = window.WebSocket;
        window.WebSocket = class extends N {
          constructor(u, p) {
            super(String(u).replace("127.0.0.1:8765", "127.0.0.1:" + port), p);
          }
        };
      },
      [PORT],
    );
    await page.goto(`http://localhost:${VITE}/?token=${TOKEN}`);
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 90000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) {
      await modal.click();
      await page.waitForTimeout(300);
    }

    await page.evaluate(async (gap) => {
      const s = window.store;
      const box = (l, w, h, b, dx, dy, dz) => {
        s.addFeature({ id: s.nextId(), type: "box", length: l, width: w, height: h });
        s.addFeature({ id: s.nextId(), type: "move", bodies: [b], dx, dy, dz, rx: 0, ry: 0, rz: 0 });
      };
      box(400, 400, 2, "body1", 0, 0, -1);
      box(400, 400, 2, "body2", 0, 0, gap - 1);
      // Off to the side and out of view, tall enough that the scene's box holds the eye.
      box(10, 10, 2000, "body3", 1500, -1500, 1000);
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 3) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }, GAP);
    await page.waitForTimeout(1500);

    const setup = await page.evaluate((control) => {
      const vp = window.viewport;
      const paint = (id, v) => {
        const b = vp.model.bodies.find((x) => x.id === id);
        const c = b.mesh.geometry.attributes.color;
        c.array.fill(v);
        c.needsUpdate = true;
        b.baseColors.fill(v);
      };
      paint("body1", 1);
      paint("body2", 0.02);
      if (control) vp.rig.setContentBox(vp.model.box);
      const sc = vp.scene;
      sc.grid.group.visible = false;
      sc.triad.group.visible = false;
      const b = vp.model.box;
      return { bodies: vp.model.bodies.map((x) => x.id), box: [b.min.toArray(), b.max.toArray()] };
    }, CONTROL);
    res.setup = setup;

    const step = (d) =>
      page.evaluate(async (d) => {
        const vp = window.viewport;
        const V = vp.rig.active.position.constructor;
        const T = new V(0, 0, 0);
        vp.rig.setLookAt(new V(0, -0.6 * d, 0.8 * d), T, false);
        const shot = async (under) => {
          vp.model.bodies.find((x) => x.id === "body1").mesh.visible = under;
          vp.requestRender();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const url = vp.screenshotPNG();
          const img = await new Promise((ok, no) => {
            const i = new Image();
            i.onload = () => ok(i);
            i.onerror = no;
            i.src = url;
          });
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          return { url, data: g.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
        };
        const alone = await shot(false);
        const both = await shot(true);
        const cam = vp.rig.active;
        const q = [
          [-170, -170],
          [170, -170],
          [170, 170],
          [-170, 170],
        ].map(([x, y]) => {
          const v = new V(x, y, 0.1).project(cam);
          return [((v.x + 1) / 2) * alone.w, ((1 - v.y) / 2) * alone.h];
        });
        const inside = (x, y) => {
          let s = 0;
          for (let i = 0; i < 4; i++) {
            const [ax, ay] = q[i],
              [bx, by] = q[(i + 1) % 4];
            const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
            if (c !== 0) {
              if (s === 0) s = Math.sign(c);
              else if (Math.sign(c) !== s) return false;
            }
          }
          return true;
        };
        let n = 0,
          bad = 0;
        const lum = (a, i) => 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
        for (let y = 0; y < alone.h; y += 2)
          for (let x = 0; x < alone.w; x += 2) {
            if (!inside(x, y)) continue;
            const i = (y * alone.w + x) * 4;
            n++;
            if (Math.abs(lum(both.data, i) - lum(alone.data, i)) > 24) bad++;
          }
        return {
          d,
          near: cam.near,
          far: cam.far,
          dist: cam.position.distanceTo(T),
          n,
          bad,
          url: bad ? both.url : null,
        };
      }, d);

    let worst = null;
    for (let d = 200; d <= 1500; d *= 1.02) {
      const r = await step(d);
      if (r.url && (!worst || r.bad > worst.bad)) {
        worst = { d: r.d, bad: r.bad };
        fs.writeFileSync(path.join(OUT, "worst.png"), Buffer.from(r.url.split(",")[1], "base64"));
      }
      delete r.url;
      res.steps.push(r);
      console.log(`d ${r.d.toFixed(1)} near ${r.near.toFixed(3)} far ${r.far.toFixed(0)} px ${r.n} stripes ${r.bad}`);
    }
    const covered = res.steps.every((s) => s.n > 2000 && Math.abs(s.dist - s.d) < 1e-3 * s.d);
    check("every step framed the plate", covered, res.steps.filter((s) => !(s.n > 2000)).slice(0, 3));
    const fights = res.steps.filter((s) => s.bad > 0);
    if (CONTROL)
      console.log(`control: ${fights.length} of ${res.steps.length} steps fight, worst ${JSON.stringify(worst)}`);
    else
      check("no step shows the plate underneath", fights.length === 0, {
        fights: fights.length,
        worst,
        first: fights[0],
      });
    check("no page errors", res.errors.length === 0, res.errors.slice(0, 3));
  } catch (e) {
    failed++;
    res.errors.push(String((e && e.stack) || e));
    console.log("FAIL", e);
  } finally {
    fs.writeFileSync(path.join(OUT, "coplanar_plates.json"), JSON.stringify(res, null, 1));
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : "ALL OK");
  process.exit(failed ? 1 : 0);
})();
