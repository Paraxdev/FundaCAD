// Home, the start screen, in a real browser against the real geometry engine.
//
//   1. Startup shows Home over the stage, with its close button, and the keyboard stays on it.
//      The title bar behind it is dimmed and takes no click or focus, all but the Home button.
//   2. Blank closes it and leaves an empty document.
//   3. File > Home and the title bar button bring it back, Escape closes it.
//   4. With unsaved work, Blank asks before discarding it.
//   5. A .funda dropped over Home opens and Home closes.
//   6. Over the fake library: edit times, a missing file shows Not found and Remove takes it off.
//   7. Search filters the cards, the sort changes their order, Ctrl+F finds the field.
//   8. Each example card opens its template as an untitled document that builds.
//   9. With 300 documents, the cards in view show their pictures and only those are fetched.
//  10. A folder added to Home lists its documents, narrow windows pick it from a Select, Remove takes it off.
//  11. The Versions drawer: the open document's branches and versions, Restore (and Ctrl+Z), branch Open,
//      Open copy, and a closed file's history read from the library.
//
//   engine --ws, vite, then
//   SC_TOKEN=<engine token> node e2e/home_e2e.cjs
// SC_URL (default http://localhost:5173/) and SC_ENGINE_PORT (default 8765) pick the setup.

const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const APP = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
}

(async () => {
  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: !process.env.SC_HEADED,
    args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
    await page.addInitScript((ws) => {
      const W = window.WebSocket;
      window.WebSocket = class extends W {
        constructor(u, p) {
          super(String(u).replace(":8765", `:${ws}`), p);
        }
      };
    }, ENGINE_PORT);
    await page.goto(`${APP}?token=${TOKEN}`);
    await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, {
      timeout: 60000,
    });
    const settle = async () => {
      await page.waitForTimeout(300);
      await page.waitForFunction(() => !window.store.buildState.building && !window.store.busy?.active, null, {
        timeout: 120000,
      });
    };
    const homeUp = () => page.evaluate(() => !!document.querySelector("#stage .home"));
    // Select.vue is a combobox over a listbox, not a native <select>.
    const pick = async (trigger, label) => {
      await page.click(trigger);
      await page.click(`.select-pop [role="option"]:has(.opt-label:text-is("${label}"))`);
    };
    const optionsOf = async (trigger) => {
      await page.click(trigger);
      const labels = await page.$$eval('.select-pop [role="option"]', (els) => els.map((e) => e.textContent.trim()));
      await page.keyboard.press("Escape");
      return labels.join(",");
    };
    const menu = async (top, item) => {
      await page.click(`.menu-btn:has-text("${top}")`);
      await page.click(`.menu-popup:not(.hidden) .menu-item:has-text("${item}")`);
    };

    console.log("1. startup");
    check("Home is up at startup", await homeUp());
    const label = await page.getAttribute(".home .modal-close", "aria-label");
    check("its close button is .modal-close", label === "Back to the document", label);

    console.log("1b. keyboard");
    const focusIn = () =>
      page.evaluate(() => {
        const a = document.activeElement;
        if (a?.closest(".home")) return "home";
        if (a?.id === "home-btn") return "home-btn";
        if (a?.closest("#titlebar")) return "bar";
        return a?.closest("#float-layer, #stage") ? "behind" : (a?.tagName ?? "none");
      });
    check("Home has the focus at startup", (await focusIn()) === "home", await focusIn());
    const walk = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      walk.push(await focusIn());
    }
    check("Tab never lands on what Home covers", !walk.includes("behind"), walk.join(" "));
    check("Tab never lands in the title bar but on its Home button", !walk.includes("bar"), walk.join(" "));
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".cmdk-backdrop", { timeout: 2000 }).catch(() => null);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const afterPalette = await page.evaluate(() => ({
      palette: !!document.querySelector(".cmdk-backdrop"),
      home: !!document.querySelector("#stage .home"),
    }));
    check(
      "Escape closes the palette over Home and leaves Home up",
      !afterPalette.palette && afterPalette.home,
      JSON.stringify(afterPalette),
    );
    const bar = await page.evaluate(() => {
      const file = [...document.querySelectorAll(".menu-btn")].find((b) => b.textContent.trim() === "File");
      const r = file.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const home = document.querySelector("#home-btn");
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        hitsFile: !!hit?.closest(".menu-btn"),
        off: ["#menubar", "#undo-btn", "#docname", "#workspace-toggle"].every(
          (sel) => !!document.querySelector(sel)?.closest("[inert]"),
        ),
        dim: Number(getComputedStyle(document.querySelector("#workspace-toggle")).opacity),
        homeLive: !home.closest("[inert]") && home.classList.contains("active"),
      };
    });
    check(
      "the title bar behind Home is inert and dimmed",
      !bar.hitsFile && bar.off && bar.dim < 0.5,
      JSON.stringify(bar),
    );
    check("its Home button stays live and shows Home is open", bar.homeLive, JSON.stringify(bar));
    await page.mouse.click(bar.x, bar.y);
    await page.waitForTimeout(200);
    const afterClick = await page.evaluate(() => ({
      menu: !!document.querySelector(".menu-popup:not(.hidden)"),
      home: !!document.querySelector("#stage .home"),
    }));
    check(
      "a click on File over Home opens no menu and leaves Home up",
      !afterClick.menu && afterClick.home,
      JSON.stringify(afterClick),
    );

    console.log("2. Blank");
    await page.click(".home-new-blank");
    await page.waitForTimeout(300);
    check("Blank closes Home", !(await homeUp()));
    const live = await page.evaluate(() => ({
      inert: document.querySelectorAll("#titlebar [inert]").length,
      dim: Number(getComputedStyle(document.querySelector("#workspace-toggle")).opacity),
      active: document.querySelector("#home-btn").classList.contains("active"),
    }));
    check(
      "the title bar is live again once Home closes",
      live.inert === 0 && live.dim === 1 && !live.active,
      JSON.stringify(live),
    );
    const blank = await page.evaluate(() => window.store.document.features.length);
    check("the document is empty", blank === 0, String(blank));

    console.log("3. File > Home and the title bar button");
    await page.click('#titlebar [title="Home"]');
    await page.waitForTimeout(200);
    check("the title bar button opens it", await homeUp());
    await page.click('#titlebar [title="Home"]');
    await page.waitForTimeout(200);
    check("the button again goes back to the document", !(await homeUp()));
    await menu("File", "Home");
    await page.waitForTimeout(200);
    check("File > Home opens it", await homeUp());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("Escape closes it", !(await homeUp()));

    console.log("4. unsaved work");
    await page.evaluate(() => window.store.addFeature({ id: "b1", type: "box", length: 10, width: 10, height: 10 }));
    await settle();
    await menu("File", "Home");
    await page.click(".home-new-blank");
    await page.waitForSelector("button:has-text('Discard')", { timeout: 5000 });
    check("Blank asks before discarding", true);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const kept = await page.evaluate(() => window.store.document.features.length);
    check("Escape on the question keeps the work and Home", kept === 1 && (await homeUp()), String(kept));

    console.log("5. a drop over Home");
    const doc = JSON.stringify({
      parameters: {},
      features: [{ id: "f1", type: "box", length: 20, width: 10, height: 5 }],
    });
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], "dropped.funda"));
      const el = document.querySelector("#stage .home");
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
        }),
      );
    }, doc);
    await page.waitForSelector("button:has-text('Discard')", { timeout: 5000 });
    await page.click("button:has-text('Discard')");
    await settle();
    const dropped = await page.evaluate(() => ({
      name: window.store.fileName,
      n: window.store.document.features.length,
    }));
    check("the dropped document opened", /dropped/.test(dropped.name) && dropped.n === 1, JSON.stringify(dropped));
    check("Home closed", !(await homeUp()));

    console.log("6. recent documents over the fake library");
    await page.evaluate(() => {
      const now = Date.now();
      localStorage.setItem(
        "fundacad.recentFiles",
        JSON.stringify([
          { path: "C:/work/bracket.funda", openedAt: now - 1000 },
          { path: "C:/work/gone.funda", openedAt: now - 2000 },
        ]),
      );
      window.__fundacad.home.useFakeLibrary([{ path: "C:/work/bracket.funda", mtimeMs: now - 3 * 3600_000 }]);
    });
    await menu("File", "Home");
    await page.waitForTimeout(300);
    const cards = await page.$$eval(".home-card", (els) =>
      els.map((el) => ({
        name: el.querySelector(".home-card-name").textContent,
        time: el.querySelector(".home-card-time").textContent,
        badge: el.querySelector(".home-badge")?.textContent ?? "",
      })),
    );
    check("two cards", cards.length === 2, JSON.stringify(cards));
    check("the edit time comes from the file", cards[0]?.time === "Edited 3 h ago", cards[0]?.time);
    check("the missing file is marked", cards[1]?.badge === "Not found", JSON.stringify(cards[1]));
    await page.click(".home-card.missing");
    await page.click("button:has-text('Remove from list')");
    await page.waitForTimeout(200);
    const left = await page.$$eval(".home-card-name", (els) => els.map((el) => el.textContent));
    check("Remove takes it off", JSON.stringify(left) === '["bracket"]', JSON.stringify(left));

    console.log("7. search and sort");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const now = Date.now();
      localStorage.setItem(
        "fundacad.recentFiles",
        JSON.stringify([
          { path: "C:/work/acme/bracket.funda", openedAt: now - 1000 },
          { path: "C:/work/misc/gear.funda", openedAt: now - 2000 },
          { path: "C:/work/misc/axle.funda", openedAt: now - 3000 },
        ]),
      );
      window.__fundacad.home.useFakeLibrary([
        { path: "C:/work/acme/bracket.funda", mtimeMs: now - 50000 },
        { path: "C:/work/misc/gear.funda", mtimeMs: now - 1000 },
        { path: "C:/work/misc/axle.funda", mtimeMs: now - 9000 },
      ]);
    });
    await menu("File", "Home");
    await page.waitForTimeout(300);
    const names = () => page.$$eval(".home-card-name", (els) => els.map((el) => el.textContent).join(","));
    await page.keyboard.press("Control+f");
    const focused = await page.evaluate(() => !!document.activeElement?.closest(".home-search"));
    check("Ctrl+F focuses the search field", focused);
    const palette = await page.evaluate(() => !!document.querySelector(".cmdk-card"));
    check("and does not open the palette", !palette);
    await page.keyboard.type("misc");
    await page.waitForTimeout(100);
    check("search filters by folder", (await names()) === "gear,axle", await names());
    await page.fill(".home-search input", "");
    await pick(".home-sort", "Name");
    check("Name sorts by name", (await names()) === "axle,bracket,gear", await names());
    await pick(".home-sort", "Last edited");
    check("Last edited sorts by the file time", (await names()) === "gear,axle,bracket", await names());
    await pick(".home-sort", "Last opened");

    console.log("8. templates");
    const bodyCounts = { Plate: 1, "Wall bracket": 1, "Pinned lever": 1, "Box with a lid": 2 };
    for (const [name, count] of Object.entries(bodyCounts)) {
      if (!(await homeUp())) await menu("File", "Home");
      await page.click(`.home-example:has-text("${name}")`);
      const discard = await page.waitForSelector("button:has-text('Discard')", { timeout: 1500 }).catch(() => null);
      if (discard) await discard.click();
      await settle();
      const got = await page.evaluate(() => ({
        name: window.store.fileName,
        path: window.store.filePath,
        dirty: window.store.dirty,
        error: window.store.buildState.errorMessage,
        bodies: window.store.buildState.result?.bodies?.length ?? 0,
        triangles: (window.store.buildState.result?.mesh?.indices?.length ?? 0) / 3,
      }));
      check(
        `${name} opens untitled and clean`,
        got.name === name && got.path === null && !got.dirty,
        JSON.stringify(got),
      );
      check(`${name} builds`, !got.error && got.bodies === count, JSON.stringify(got));
      // A plain block is 12 triangles, each hole adds a wall.
      if (name === "Plate") check("Plate has its holes", got.triangles > 100, `${got.triangles} triangles`);
      check(`${name} closes Home`, !(await homeUp()));
    }

    console.log("9. pictures on 300 cards");
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 48;
      c.height = 30;
      const g = c.getContext("2d");
      g.fillStyle = "#c03020";
      g.fillRect(0, 0, 48, 30);
      const thumb = c.toDataURL("image/jpeg", 0.85);
      const now = Date.now();
      const files = Array.from({ length: 300 }, (_, i) => ({
        path: `C:/many/doc${String(i).padStart(3, "0")}.funda`,
        mtimeMs: now - i * 1000,
        thumb,
      }));
      localStorage.setItem(
        "fundacad.recentFiles",
        JSON.stringify(files.map((f, i) => ({ path: f.path, openedAt: now - i }))),
      );
      window.__fundacad.home.useFakeLibrary(files);
    });
    if (!(await homeUp())) await menu("File", "Home");
    await page
      .waitForFunction(() => document.querySelectorAll(".home-card-pic img").length > 0, null, { timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(300);
    const first = await page.evaluate(() => ({
      cards: document.querySelectorAll(".home-card").length,
      pics: document.querySelectorAll(".home-card-pic img").length,
      asked: window.__fundacad.home.thumbRequests(),
      firstPic: !!document.querySelector(".home-card .home-card-pic img"),
      tall: document.querySelector(".home-card").getBoundingClientRect().height,
    }));
    if (process.env.SC_SHOTS) await page.screenshot({ path: `${process.env.SC_SHOTS}/home300.png` });
    check("300 cards", first.cards === 300, `${first.cards}`);
    check("the cards keep their height", first.tall > 150, `${first.tall}`);
    check("the first card shows its picture", first.firstPic);
    check(
      "only cards near the view were fetched",
      first.asked.length > 0 && first.asked.length < 100,
      `${first.asked.length}`,
    );
    check("the last card was not fetched yet", !first.asked.includes("C:/many/doc299.funda"));
    await page.evaluate(() => {
      const g = document.querySelector(".home-scroll");
      g.scrollTop = g.scrollHeight;
    });
    await page
      .waitForFunction(() => window.__fundacad.home.thumbRequests().includes("C:/many/doc299.funda"), null, {
        timeout: 5000,
      })
      .catch(() => {});
    const after = await page.evaluate(() => window.__fundacad.home.thumbRequests());
    check("scrolling to the end fetches the last cards", after.includes("C:/many/doc299.funda"), `${after.length}`);
    check("and still not every card", after.length < 300, `${after.length}`);
    await page.keyboard.press("Escape");

    console.log("10. folders");
    await page.evaluate(() => {
      const now = Date.now();
      localStorage.setItem("fundacad.recentFiles", "[]");
      localStorage.removeItem("fundacad.home.folders");
      window.__fundacad.home.useFakeLibrary(
        [
          { path: "D:/proj/gearbox.funda", mtimeMs: now - 1000 },
          { path: "D:/proj/parts/shaft.fundab", mtimeMs: now - 5000 },
          { path: "D:/other/elsewhere.funda", mtimeMs: now },
        ],
        ["D:/proj"],
      );
    });
    await menu("File", "Home");
    await page.click(".home-add-folder");
    await page.waitForSelector(".home-folder-row.is-selected", { timeout: 3000 }).catch(() => {});
    const folderCards = await page.$$eval(".home-card-name", (els) => els.map((e) => e.textContent).join(","));
    check(
      "the added folder is listed",
      (await page.textContent(".home-folder-row").catch(() => ""))?.trim() === "proj",
    );
    check("its documents and those of its subfolders show", folderCards === "gearbox,shaft", folderCards);
    const sorts = await optionsOf(".home-sort");
    check("a folder sorts by edit time or name", sorts === "Last edited,Name", sorts);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.waitForTimeout(300);
    const narrow = await page.evaluate(() => ({
      side: getComputedStyle(document.querySelector(".home-side")).display,
      select: getComputedStyle(document.querySelector(".home-view-select")).display,
    }));
    narrow.options = await optionsOf(".home-view-select");
    check(
      "a narrow window picks the folder from a Select",
      narrow.side === "none" && narrow.select !== "none" && narrow.options === "Recent,proj,Add folder…",
      JSON.stringify(narrow),
    );
    await pick(".home-view-select", "Recent");
    await page.waitForTimeout(200);
    check("the Select goes back to Recent", (await page.$$(".home-card")).length === 0);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(300);
    await page.click(".home-folder-row", { button: "right" });
    await page.click(".ctx-item:has-text('Remove from Home')");
    await page.waitForTimeout(200);
    check("Remove from Home takes the folder off", (await page.$$(".home-folder-row")).length === 0);
    const stored = await page.evaluate(() => localStorage.getItem("fundacad.home.folders"));
    check("and forgets it", stored === "[]", stored);
    await page.keyboard.press("Escape");

    console.log("11. versions");
    const P = "D:/proj/part.funda";
    await page.evaluate((path) => {
      const s = window.store;
      s.newDocument();
      s.addFeature({ id: "b1", type: "box", length: 30, width: 20, height: 10 });
      s.saveVersion("Base block");
      s.addFeature({ id: "c1", type: "cylinder", radius: 4, height: 30 });
      s.saveVersion("Add a peg");
      s.branchFromVersion(s.versionRepo.versions[0].id, "wide");
      s.updateFeature("b1", { width: 60 });
      s.saveVersion("Wider");
      s.markSaved(path);
      const now = Date.now();
      localStorage.setItem(
        "fundacad.recentFiles",
        JSON.stringify([
          { path, openedAt: now },
          { path: "D:/proj/old.funda", openedAt: now - 1000 },
        ]),
      );
      const row = (id, parent, branch, message, time) => ({ id, parent, branch, message, time });
      window.__fundacad.home.useFakeLibrary([
        { path, mtimeMs: now },
        {
          path: "D:/proj/old.funda",
          mtimeMs: now - 5000,
          summary: {
            format: "fundab",
            versions: [row("o1", null, "main", "Old start", now - 9e6), row("o2", "o1", "main", "Old end", now - 8e6)],
            branches: { main: "o2" },
            current: "main",
          },
        },
      ]);
    }, P);
    await settle();
    const state = () =>
      page.evaluate(() => ({
        features: window.store.document.features.map((f) => f.id).join(","),
        width: window.store.document.features.find((f) => f.id === "b1")?.width,
        dirty: window.store.dirty,
        current: window.store.versionRepo?.current,
        path: window.store.filePath,
        name: window.store.fileName,
      }));
    const drawerOf = async (name) => {
      if (!(await homeUp())) await menu("File", "Home");
      await page.hover(`.home-cell:has(.home-card-name:text-is("${name}"))`);
      await page.click(`.home-cell:has(.home-card-name:text-is("${name}")) .home-card-versions`);
      await page.waitForSelector(".home-drawer .home-branch, .home-drawer-note", { timeout: 3000 });
    };
    await drawerOf("part");
    const branchRows = await page.$$eval(".home-branch-name", (els) => els.map((e) => e.textContent.trim()).join(","));
    check("the drawer lists the branches, current first", branchRows === "widecurrent,main", branchRows);
    await page.click('.home-branch-name:has-text("main")');
    const mainRows = await page.$$eval(".home-version-msg", (els) => els.map((e) => e.textContent).join(","));
    check("and the versions of the branch picked, newest first", mainRows === "Add a peg,Base block", mainRows);
    await page.click('.home-version:has-text("Base block") .home-version-restore');
    await settle();
    let st = await state();
    check("Restore brings the old features back", st.features === "b1" && st.width === 20, JSON.stringify(st));
    check("and leaves the document unsaved, same file", st.dirty && st.path === P, JSON.stringify(st));
    check("Restore closes Home", !(await homeUp()));
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Control+z");
    await settle();
    st = await state();
    check("Ctrl+Z goes back to what was there", st.features === "b1" && st.width === 60, JSON.stringify(st));
    await drawerOf("part");
    await page.click('.home-branch:has(.home-branch-name:has-text("main")) .home-branch-open');
    await settle();
    st = await state();
    check("branch Open switches the branch", st.current === "main" && st.features === "b1,c1", JSON.stringify(st));
    await drawerOf("part");
    await page.click('.home-version:has-text("Add a peg") .home-version-copy');
    const askCopy = await page.waitForSelector("button:has-text('Discard')", { timeout: 1500 }).catch(() => null);
    check("Open copy asks before replacing unsaved work", !!askCopy);
    if (askCopy) await askCopy.click();
    await settle();
    st = await state();
    check(
      "Open copy starts an untitled copy at that version",
      st.path === null && st.name === "part (Add a peg)" && st.features === "b1,c1",
      JSON.stringify(st),
    );
    await drawerOf("old");
    const oldRows = await page.$$eval(".home-version-msg", (els) => els.map((e) => e.textContent).join(","));
    check("a closed file's versions come from the library", oldRows === "Old end,Old start", oldRows);
    await page.keyboard.press("Escape");
    check("Escape closes the drawer first", (await homeUp()) && !(await page.$(".home-drawer")));
    await page.keyboard.press("Escape");
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
