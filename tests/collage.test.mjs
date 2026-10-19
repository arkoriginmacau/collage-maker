import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const html = readFileSync(join(root, "index.html"));
const shotDir = "/tmp/collage-shots";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function near(actual, expected, tol, message) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(message + " (got " + actual + ", expected " + expected + " ± " + tol + ")");
  }
}

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = "http://127.0.0.1:" + port + "/";

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") pageErrors.push(msg.text());
});
await page.evaluateOnNewDocument(() => {
  window.__liaHeights = [];
  window.addEventListener("message", (event) => {
    var data = event.data;
    if (data && data.type === "lia-height") window.__liaHeights.push(data.height);
  });
});

try {
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector(".seam-v");
  await page.waitForFunction(() => window.__liaHeights && window.__liaHeights.length > 0);

  const version = await page.$eval("[data-version-slot]", (el) => el.textContent.trim());
  assert(version === "v" + pkg.version, "footer version should be v" + pkg.version + ", got " + version);
  const meta = await page.$eval('meta[name="app-version"]', (el) => el.content);
  assert(meta === pkg.version, "meta version mismatch");
  const apiVersion = await page.evaluate(() => window.__collage.version());
  assert(apiVersion === pkg.version, "api version mismatch");

  const touchAction = await page.evaluate(() => {
    function ta(sel) {
      return getComputedStyle(document.querySelector(sel)).touchAction;
    }
    return { frame: ta("#frame"), slot: ta(".slot"), seam: ta(".seam") };
  });
  assert(touchAction.frame === "pan-y", "frame should allow vertical scrolling, got " + touchAction.frame);
  assert(touchAction.slot === "pan-y", "empty slot should allow vertical scrolling, got " + touchAction.slot);
  assert(touchAction.seam === "none", "divider should keep touch-action none, got " + touchAction.seam);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const lia = await page.evaluate(() => ({
    heights: window.__liaHeights.slice(),
    scrollHeight: document.documentElement.scrollHeight
  }));
  assert(lia.heights.length > 0, "posts lia-height on load");
  assert(lia.heights[lia.heights.length - 1] === lia.scrollHeight, "lia-height should match scrollHeight " + JSON.stringify(lia));
  const liaCount = lia.heights.length;
  await page.setViewport({ width: 1100, height: 860, deviceScaleFactor: 1 });
  await page.waitForFunction((count) => window.__liaHeights.length > count, {}, liaCount);
  const liaResized = await page.evaluate(() => ({
    height: window.__liaHeights[window.__liaHeights.length - 1],
    scrollHeight: document.documentElement.scrollHeight
  }));
  assert(liaResized.height === liaResized.scrollHeight, "resize posts the new scroll height " + JSON.stringify(liaResized));
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });

  const scrollChrome = await page.evaluate(() => {
    const htmlStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const offenders = [];
    const nodes = [document.documentElement, document.body, ...document.querySelectorAll("body *")];
    nodes.forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.overflowY === "auto" || cs.overflowY === "scroll" || cs.overflowX === "auto" || cs.overflowX === "scroll") {
        offenders.push((el.id || el.className || el.tagName) + " " + cs.overflowX + "/" + cs.overflowY);
      }
    });
    return {
      htmlOverflow: htmlStyle.overflowY,
      bodyOverflow: bodyStyle.overflowY,
      htmlBar: htmlStyle.scrollbarWidth,
      bodyBar: bodyStyle.scrollbarWidth,
      htmlBehavior: htmlStyle.scrollBehavior,
      bodyBehavior: bodyStyle.scrollBehavior,
      htmlWebkit: getComputedStyle(document.documentElement, "::-webkit-scrollbar").display,
      bodyWebkit: getComputedStyle(document.body, "::-webkit-scrollbar").display,
      offenders
    };
  });
  assert(scrollChrome.htmlBar === "none" && scrollChrome.bodyBar === "none", "scrollbar hidden on html/body " + JSON.stringify(scrollChrome));
  assert(scrollChrome.htmlWebkit === "none" && scrollChrome.bodyWebkit === "none", "webkit scrollbar hidden " + JSON.stringify(scrollChrome));
  assert(scrollChrome.htmlOverflow === "visible" && scrollChrome.bodyOverflow === "visible", "html/body stay overflow visible " + JSON.stringify(scrollChrome));
  assert(scrollChrome.htmlBehavior === "auto" && scrollChrome.bodyBehavior === "auto", "native scroll behavior unchanged " + JSON.stringify(scrollChrome));
  assert(scrollChrome.offenders.length === 0, "no internal scroll container " + scrollChrome.offenders.join(", "));

  await page.setViewport({ width: 390, height: 700, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  const wheelPoint = await page.$eval("h1", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + 30, y: r.y + 8 };
  });
  await page.mouse.move(wheelPoint.x, wheelPoint.y);
  await page.mouse.wheel({ deltaY: 100 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const wheelBefore = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel({ deltaY: 100 });
  await page.mouse.wheel({ deltaY: 100 });
  await page.mouse.wheel({ deltaY: 100 });
  const wheelAfter = await page.evaluate(() => window.scrollY);
  assert(wheelAfter - wheelBefore === 300, "wheel scroll stays 100px per notch (" + wheelBefore + " -> " + wheelAfter + ")");

  const naturalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewport({ width: 390, height: naturalHeight, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.wheel({ deltaY: 240 });
  const fitted = await page.evaluate(() => ({
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight
  }));
  assert(fitted.clientHeight === fitted.scrollHeight, "natural height fits the frame " + JSON.stringify(fitted));
  assert(fitted.scrollY === 0, "a fitted frame does not scroll internally " + JSON.stringify(fitted));
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });

  const seamPlan = await page.evaluate(() => {
    const keys = ["ls", "2v", "2h", "3v", "4v", "5v", "3l", "3t", "4"];
    const out = {};
    keys.forEach((key) => {
      window.__collage.applyLayout(key);
      out[key] = window.__collage.seams().map((s) => s.axis + ":" + s.index + ":" + s.start + "-" + s.end);
    });
    window.__collage.applyLayout("2v");
    return out;
  });
  assert(JSON.stringify(seamPlan["ls"]) === JSON.stringify(["v:0:1-2", "h:0:1-2"]), "ls seams " + seamPlan["ls"]);
  assert(JSON.stringify(seamPlan["2v"]) === JSON.stringify(["v:0:0-1"]), "2v seam " + seamPlan["2v"]);
  assert(JSON.stringify(seamPlan["2h"]) === JSON.stringify(["h:0:0-1"]), "2h seam " + seamPlan["2h"]);
  assert(seamPlan["3v"].length === 2 && seamPlan["3v"].every((s) => s.startsWith("v:")), "3v seams");
  assert(seamPlan["4v"].length === 3, "4v seams");
  assert(seamPlan["5v"].length === 4, "5v seams");
  assert(JSON.stringify(seamPlan["3l"]) === JSON.stringify(["v:0:0-2", "h:0:1-2"]), "3l seams " + seamPlan["3l"]);
  assert(JSON.stringify(seamPlan["3t"]) === JSON.stringify(["v:0:1-2", "h:0:0-2"]), "3t seams " + seamPlan["3t"]);
  assert(JSON.stringify(seamPlan["4"]) === JSON.stringify(["v:0:0-2", "h:0:0-2"]), "4 seams " + seamPlan["4"]);

  const lsGeom = await page.evaluate(() => {
    window.__collage.applyLayout("ls");
    window.__collage.resetCells();
    const frame = document.getElementById("frame");
    const fr = frame.getBoundingClientRect();
    const lSlot = document.querySelector('.slot[data-index="0"]');
    const square = document.querySelector('.slot[data-index="1"]');
    const b = square.getBoundingClientRect();
    const h = document.querySelector(".seam-h").getBoundingClientRect();
    const v = document.querySelector(".seam-v").getBoundingClientRect();
    function slotIndexAt(xRatio, yRatio) {
      const hit = document.elementFromPoint(fr.left + fr.width * xRatio, fr.top + fr.height * yRatio);
      const slot = hit && hit.closest ? hit.closest(".slot") : null;
      return slot ? slot.dataset.index : "";
    }
    const before = measure();
    seamDrag(document.querySelector(".seam-v"), 50, 0, 71);
    const afterV = measure();
    window.__collage.resetCells();
    seamDrag(document.querySelector(".seam-h"), 0, -36, 72);
    const afterH = measure();
    const snap = {
      hidden: document.querySelectorAll(".slot.hidden").length,
      resetDisabled: document.getElementById("resetCellsBtn").disabled,
      noVoid: !document.getElementById("voidCell"),
      clip: lSlot.style.clipPath.indexOf("polygon") === 0,
      hits: {
        topRight: slotIndexAt(0.75, 0.22),
        bottomLeft: slotIndexAt(0.22, 0.75),
        bottomRight: slotIndexAt(0.75, 0.78)
      },
      b: {
        l: (b.left - fr.left) / fr.width,
        t: (b.top - fr.top) / fr.height,
        r: (b.right - fr.left) / fr.width,
        b: (b.bottom - fr.top) / fr.height
      },
      seam: {
        hLeft: (h.left - fr.left) / fr.width,
        hRight: (h.right - fr.left) / fr.width,
        vTop: (v.top - fr.top) / fr.height,
        vBottom: (v.bottom - fr.top) / fr.height
      }
    };
    window.__collage.resetCells();
    window.__collage.applyLayout("3l");
    const three = {
      count: document.querySelectorAll(".slot:not(.hidden)").length,
      areas: getComputedStyle(frame).gridTemplateAreas
    };
    window.__collage.applyLayout("2v");
    return {
      ...snap,
      first: document.querySelector(".layout-btn").dataset.layout,
      order: [...document.querySelectorAll(".layout-btn")].map((btn) => btn.dataset.layout).join(","),
      old: !!document.querySelector('[data-layout="1"]'),
      active: document.querySelector(".layout-btn.active").dataset.layout,
      before,
      afterV,
      afterH,
      three
    };
    function measure() {
      const sq = document.querySelector('.slot[data-index="1"]').getBoundingClientRect();
      const stem = parseFloat(getComputedStyle(frame).getPropertyValue("--ls-left"));
      return { bw: sq.width, bh: sq.height, lw: stem };
    }
    function seamDrag(el, dx, dy, id) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType: "mouse", button: 0
      }));
      document.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, clientX: x + dx, clientY: y + dy, pointerId: id, pointerType: "mouse"
      }));
      document.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, clientX: x + dx, clientY: y + dy, pointerId: id, pointerType: "mouse"
      }));
    }
  });
  assert(lsGeom.first === "ls" && !lsGeom.old, "first picker slot is the L layout, single full-frame is gone");
  assert(lsGeom.order === "ls,2v,3v,4v,5v,2h,3l,3t,4", "other layouts stay in place " + lsGeom.order);
  assert(lsGeom.hidden === 3 && lsGeom.noVoid, "L layout is two photo cells");
  assert(!lsGeom.resetDisabled, "reset sizes stays available");
  assert(lsGeom.clip, "L photo is one clipped cell");
  assert(lsGeom.hits.topRight === "0" && lsGeom.hits.bottomLeft === "0", "top-right and bottom-left are the L photo " + JSON.stringify(lsGeom.hits));
  assert(lsGeom.hits.bottomRight === "1", "bottom-right is the square photo");
  assert(lsGeom.b.l > 0.4 && lsGeom.b.t > 0.4 && lsGeom.b.r > 0.9 && lsGeom.b.b > 0.9, "square sits in the bottom-right " + JSON.stringify(lsGeom.b));
  assert(lsGeom.seam.hLeft > 0.4 && lsGeom.seam.hRight > 0.9, "horizontal handle stays on the right column");
  assert(lsGeom.seam.vTop > 0.35 && lsGeom.seam.vBottom > 0.9, "vertical handle stays beside the square " + JSON.stringify(lsGeom.seam));
  assert(lsGeom.afterV.lw > lsGeom.before.lw + 30, "vertical drag widens the L stem");
  assert(lsGeom.afterV.bw < lsGeom.before.bw - 30, "vertical drag narrows the square");
  assert(lsGeom.afterH.bh > lsGeom.before.bh + 20, "horizontal drag grows the square");
  near(lsGeom.afterH.lw, lsGeom.before.lw, 2, "horizontal drag keeps the column split");
  assert(lsGeom.three.count === 3, "large-left layout still has three photo cells");
  assert(lsGeom.three.areas.replace(/"/g, "") === "a b a c", "large-left areas unchanged " + lsGeom.three.areas);
  assert(lsGeom.active === "2v", "restored the side-by-side layout");

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const splitBar = await page.evaluate(() => {
    window.__collage.applyLayout("2v");
    const hiddenOn2v = document.getElementById("splitResize").hidden;
    window.__collage.applyLayout("ls");
    window.__collage.resetCells();
    const bar = document.getElementById("splitResize");
    const track = document.getElementById("splitTrack");
    const frame = document.getElementById("frame");
    const fr = frame.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    const tr = track.getBoundingClientRect();
    const sq = document.querySelector('.slot[data-index="1"]').getBoundingClientRect();
    const thumb = document.getElementById("splitThumb").getBoundingClientRect();
    return {
      hiddenOn2v,
      hidden: bar.hidden,
      below: br.top >= fr.bottom - 2,
      trackH: tr.height,
      label: bar.querySelector(".split-label").textContent,
      thumbInside: thumb.left >= tr.left - 1 && thumb.right <= tr.right + 1,
      startW: sq.width / fr.width,
      startH: sq.height / fr.height,
      hint: document.querySelector(".hint-text").textContent
    };
  });
  assert(splitBar.hiddenOn2v, "square size bar stays hidden on other layouts");
  assert(!splitBar.hidden, "square size bar shows on the L layout");
  assert(splitBar.below, "square size bar sits under the collage");
  assert(splitBar.trackH >= 48, "square size bar is finger-sized, height " + splitBar.trackH);
  assert(splitBar.label === "Square size", "bar is labeled for the square split");
  assert(splitBar.thumbInside, "thumb stays inside the track");
  assert(splitBar.hint.indexOf("Square size") !== -1, "help text under the collage points at the bar");
  assert(splitBar.startW < 0.6 && splitBar.startH < 0.6, "square starts near half the frame");

  const grown = await page.evaluate(() => {
    const track = document.getElementById("splitTrack");
    const rect = track.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    track.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: y, pointerId: 81, pointerType: "touch", button: 0
    }));
    track.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: rect.right, clientY: y, pointerId: 81, pointerType: "touch"
    }));
    track.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: rect.right, clientY: y, pointerId: 81, pointerType: "touch"
    }));
    const frame = document.getElementById("frame").getBoundingClientRect();
    const sq = document.querySelector('.slot[data-index="1"]').getBoundingClientRect();
    const thumb = document.getElementById("splitThumb").getBoundingClientRect();
    const tr = track.getBoundingClientRect();
    return {
      w: sq.width / frame.width,
      h: sq.height / frame.height,
      thumbInside: thumb.left >= tr.left - 1 && thumb.right <= tr.right + 1,
      overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    };
  });
  assert(grown.w > 0.7, "dragging the bar right grows the square width, got " + grown.w);
  assert(grown.h > 0.7, "dragging the bar right grows the square height, got " + grown.h);
  assert(grown.thumbInside, "thumb stays inside the track at the large size");
  assert(grown.overflow, "square size bar does not overflow the phone width");

  const shrunk = await page.evaluate(() => {
    const track = document.getElementById("splitTrack");
    const rect = track.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    track.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: rect.right, clientY: y, pointerId: 82, pointerType: "touch", button: 0
    }));
    track.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: rect.left, clientY: y, pointerId: 82, pointerType: "touch"
    }));
    track.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: rect.left, clientY: y, pointerId: 82, pointerType: "touch"
    }));
    const frame = document.getElementById("frame").getBoundingClientRect();
    const sq = document.querySelector('.slot[data-index="1"]').getBoundingClientRect();
    return { w: sq.width / frame.width, h: sq.height / frame.height, px: sq.width };
  });
  assert(shrunk.w < 0.28 && shrunk.h < 0.28, "dragging the bar left shrinks the square " + JSON.stringify(shrunk));
  assert(shrunk.px >= 36, "shrunk square keeps a minimum size, got " + shrunk.px);

  await page.focus("#splitTrack");
  const keyed = await page.evaluate(() => {
    const before = document.querySelector('.slot[data-index="1"]').getBoundingClientRect().width;
    document.getElementById("splitTrack").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    const after = document.querySelector('.slot[data-index="1"]').getBoundingClientRect().width;
    return { before, after };
  });
  assert(keyed.after > keyed.before + 4, "ArrowRight grows the square (" + keyed.before + " -> " + keyed.after + ")");

  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  await page.evaluate(() => {
    window.__collage.applyLayout("2v");
    window.__collage.resetCells();
  });

  await page.evaluate(() => window.__collage.applyLayout("2v"));
  const before = await cellWidths(page);
  const seamBox = await page.$eval(".seam-v", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height, w: r.width };
  });
  assert(seamBox.h > 80, "vertical handle should span the cells");
  await page.mouse.move(seamBox.x, seamBox.y);
  await page.mouse.down();
  await page.mouse.move(seamBox.x + 80, seamBox.y, { steps: 10 });
  await page.mouse.up();
  const after = await cellWidths(page);
  assert(after[0] > before[0] + 50, "dragging the divider right grows the left cell (" + before[0] + " -> " + after[0] + ")");
  assert(after[1] < before[1] - 50, "dragging the divider right shrinks the right cell");
  near(after[0] + after[1], before[0] + before[1], 2, "adjacent pair keeps its total width");

  const hit = await page.evaluate(() => {
    const seam = document.querySelector(".seam-v");
    const r = seam.getBoundingClientRect();
    const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return mid && (mid.classList.contains("seam") || mid.classList.contains("grip"));
  });
  assert(hit, "pointer should hit the divider, not the photo");

  const huge = await page.evaluate(() => {
    const seam = document.querySelector(".seam-v");
    const r = seam.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    seam.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: "mouse", button: 0
    }));
    document.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: x + 4000, clientY: y, pointerId: 7, pointerType: "mouse"
    }));
    document.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: x + 4000, clientY: y, pointerId: 7, pointerType: "mouse"
    }));
    const widths = [...document.querySelectorAll(".slot:not(.hidden)")].map((el) => el.getBoundingClientRect().width);
    return widths;
  });
  assert(huge[1] >= 36, "right cell respects a minimum size, got " + huge[1]);
  assert(huge[0] > huge[1], "left cell took the extra space");

  await page.click("#resetCellsBtn");
  const resetWidths = await cellWidths(page);
  near(resetWidths[0], resetWidths[1], 2, "reset sizes equalizes the two cells");

  await page.focus(".seam-v");
  await page.keyboard.press("ArrowRight");
  const nudged = await cellWidths(page);
  assert(nudged[0] > resetWidths[0] + 6, "keyboard arrow resizes the cell");

  const remembered = await page.evaluate(() => {
    const left = document.querySelector('.slot[data-index="0"]').getBoundingClientRect().width;
    window.__collage.applyLayout("4");
    window.__collage.applyLayout("2v");
    const again = document.querySelector('.slot[data-index="0"]').getBoundingClientRect().width;
    return { left, again };
  });
  near(remembered.again, remembered.left, 2, "cell sizes are kept when returning to a layout");

  await page.evaluate(() => window.__collage.applyLayout("3l"));
  const partial = await page.evaluate(() => {
    const frame = document.getElementById("frame").getBoundingClientRect();
    const h = document.querySelector(".seam-h").getBoundingClientRect();
    const v = document.querySelector(".seam-v").getBoundingClientRect();
    return {
      hLeft: (h.left - frame.left) / frame.width,
      hRight: (h.right - frame.left) / frame.width,
      vTop: (v.top - frame.top) / frame.height,
      vBottom: (v.bottom - frame.top) / frame.height
    };
  });
  assert(partial.hLeft > 0.25, "3l horizontal handle stays on the right column, left=" + partial.hLeft);
  assert(partial.hRight > 0.9, "3l horizontal handle reaches the right edge");
  assert(partial.vTop < 0.08, "3l vertical handle starts at the top");
  assert(partial.vBottom > 0.9, "3l vertical handle runs the full height");

  await page.evaluate(() => window.__collage.applyLayout("3t"));
  const partialTop = await page.evaluate(() => {
    const frame = document.getElementById("frame").getBoundingClientRect();
    const v = document.querySelector(".seam-v").getBoundingClientRect();
    const h = document.querySelector(".seam-h").getBoundingClientRect();
    return {
      vTop: (v.top - frame.top) / frame.height,
      hWidth: h.width / frame.width
    };
  });
  assert(partialTop.vTop > 0.35, "3t vertical handle stays on the bottom row");
  assert(partialTop.hWidth > 0.8, "3t horizontal handle spans the width");

  await page.evaluate(() => {
    window.__collage.applyLayout("2v");
    window.__collage.resetCells();
  });

  const red = await paint(page, (ctx, w, h) => {
    ctx.fillStyle = "#e11d48";
    ctx.fillRect(0, 0, w, h);
  }, 240, 160);
  const blue = await paint(page, (ctx, w, h) => {
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(0, 0, w, h);
  }, 240, 160);
  const bands = await paint(page, (ctx, w, h) => {
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(0, 0, w / 3, h);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(w / 3, 0, w / 3, h);
    ctx.fillStyle = "#3b82f6";
    ctx.fillRect((2 * w) / 3, 0, w / 3, h);
  }, 900, 300);

  await page.evaluate(async (redUrl, blueUrl) => {
    await window.__collage.loadDataURL(0, redUrl);
    await window.__collage.loadDataURL(1, blueUrl);
  }, red, blue);

  const sliderZoom = await page.evaluate(() => {
    const input = document.querySelector('#sizeRail [data-action="zoom"][data-slot="0"]');
    input.value = "180";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return window.__collage.slots[0].zoom;
  });
  near(sliderZoom, 1.8, 0.001, "size slider sets zoom");

  const outside = await page.evaluate(() => {
    const keys = ["ls", "2v", "2h", "3v", "4v", "5v", "3l", "3t", "4"];
    const frame = document.getElementById("frame");
    const out = {};
    keys.forEach((key) => {
      window.__collage.applyLayout(key);
      window.__collage.renderAll();
      const fr = frame.getBoundingClientRect();
      const filled = [...document.querySelectorAll(".slot.filled:not(.hidden)")];
      const bars = [...document.querySelectorAll("#sizeRail .zoom-bar.is-active")].map((bar) => {
        const r = bar.getBoundingClientRect();
        const input = bar.querySelector("input");
        const lock = bar.querySelector("[data-action='lock']");
        const lr = lock.getBoundingClientRect();
        return {
          h: r.height,
          w: r.width,
          below: r.top >= fr.bottom - 1,
          clear: r.top >= fr.bottom - 1,
          inFrame: frame.contains(bar),
          lockH: lr.height,
          lockBelow: lr.top >= fr.bottom - 1,
          slot: input.getAttribute("data-slot")
        };
      });
      const removes = [...document.querySelectorAll("#clearRow .remove-btn.is-active")].map((btn) => {
        const r = btn.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          h: r.height,
          inFrame: frame.contains(btn),
          slot: btn.getAttribute("data-slot")
        };
      }).sort((a, b) => a.left - b.left);
      out[key] = { count: bars.length, filled: filled.length, frameW: fr.width, frameLeft: fr.left, frameTop: fr.top, bars, removes };
    });
    window.__collage.applyLayout("2v");
    window.__collage.renderAll();
    return out;
  });
  ["ls", "2v", "2h", "3v", "4v", "5v", "3l", "3t", "4"].forEach((key) => {
    const row = outside[key];
    assert(row.count === row.filled && row.count > 0, key + " shows a Size control for each filled cell " + JSON.stringify(row));
    row.bars.forEach((bar) => {
      assert(bar.below && bar.clear, key + " Size control stays below the collage " + JSON.stringify(bar));
      assert(!bar.inFrame, key + " Size control is outside the frame");
      assert(bar.h >= 40, key + " Size control is touch-sized, height " + bar.h);
      assert(bar.w >= row.frameW * 0.8, key + " Size control uses the width under the frame, got " + bar.w);
      assert(bar.lockBelow && bar.lockH >= 40, key + " lock stays under the frame " + JSON.stringify(bar));
    });
    assert(row.removes.length === row.filled, key + " shows a remove control per filled cell");
    assert(Math.abs(row.removes[0].left - row.frameLeft) <= 4, key + " remove controls start at the frame's left");
    row.removes.forEach((btn) => {
      assert(btn.bottom <= row.frameTop + 1, key + " remove control sits above the frame " + JSON.stringify(btn));
      assert(!btn.inFrame, key + " remove control is outside the frame");
      assert(btn.h >= 40, key + " remove control is touch-sized, height " + btn.h);
    });
  });

  const lockedView = await page.evaluate(() => {
    const slot = window.__collage.slots[0];
    slot.zoom = 1.5;
    slot.panX = 0.2;
    slot.panY = 0.3;
    window.__collage.renderAll();
    const btn = document.querySelector('#sizeRail [data-action="lock"][data-slot="0"]');
    btn.click();
    const input = document.querySelector('#sizeRail [data-action="zoom"][data-slot="0"]');
    input.value = "300";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const zoomAfterSlider = slot.zoom;
    const el = slot.el;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: -120, clientX: r.left + 24, clientY: r.top + 24
    }));
    const zoomAfterWheel = slot.zoom;
    el.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 40, pointerId: 91, pointerType: "mouse", button: 0
    }));
    document.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: r.left - 30, clientY: r.top + 40, pointerId: 91, pointerType: "mouse"
    }));
    document.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: r.left - 30, clientY: r.top + 40, pointerId: 91, pointerType: "mouse"
    }));
    const whileLocked = {
      pressed: btn.getAttribute("aria-pressed") === "true",
      label: btn.textContent,
      disabled: input.disabled,
      zoomAfterSlider,
      zoomAfterWheel,
      panX: slot.panX
    };
    btn.click();
    input.value = "220";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const unlockedZoom = slot.zoom;
    slot.zoom = 1.8;
    slot.panX = 0.5;
    slot.panY = 0.5;
    window.__collage.renderAll();
    return { whileLocked, unlocked: !slot.locked && btn.getAttribute("aria-pressed") === "false", unlockedZoom };
  });
  assert(lockedView.whileLocked.pressed && lockedView.whileLocked.label === "Locked", "lock control shows the locked state");
  assert(lockedView.whileLocked.disabled, "Size slider is disabled while the view is locked");
  near(lockedView.whileLocked.zoomAfterSlider, 1.5, 0.001, "Size slider does not zoom a locked photo");
  near(lockedView.whileLocked.zoomAfterWheel, 1.5, 0.001, "wheel does not zoom a locked photo");
  near(lockedView.whileLocked.panX, 0.2, 0.001, "drag does not pan a locked photo");
  assert(lockedView.unlocked, "lock toggles back off");
  near(lockedView.unlockedZoom, 2.2, 0.001, "Size slider zooms again after unlock");

  const wheelZoom = await page.evaluate(() => {
    const slot = document.querySelector('.slot[data-index="0"]');
    const r = slot.getBoundingClientRect();
    slot.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -140,
      clientX: r.left + r.width * 0.25,
      clientY: r.top + r.height * 0.4
    }));
    const slotState = window.__collage.slots[0];
    const m = window.__collage.placementFor(0);
    return { zoom: slotState.zoom, coverW: m.bgW >= m.cw - 0.5, coverH: m.bgH >= m.ch - 0.5, panX: slotState.panX, panY: slotState.panY };
  });
  assert(wheelZoom.zoom > 1.8, "wheel zoom increases size, got " + wheelZoom.zoom);
  assert(wheelZoom.zoom <= 3.001, "wheel zoom stays within the slider range");
  assert(wheelZoom.coverW && wheelZoom.coverH, "wheel zoom keeps the photo covering the cell");
  assert(wheelZoom.panX >= 0 && wheelZoom.panX <= 1 && wheelZoom.panY >= 0 && wheelZoom.panY <= 1, "pan stays inside the cover");

  await page.evaluate(async (bandsUrl) => {
    await window.__collage.loadDataURL(0, bandsUrl);
    window.__collage.slots[0].zoom = 1;
    window.__collage.slots[0].panX = 0.5;
    window.__collage.slots[0].panY = 0.5;
    window.__collage.renderAll();
  }, bands);

  const pan = await page.evaluate(() => {
    const slot = document.querySelector('.slot[data-index="0"]');
    const r = slot.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    slot.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 3, pointerType: "mouse", button: 0
    }));
    document.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: x - 80, clientY: y, pointerId: 3, pointerType: "mouse"
    }));
    document.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: x - 80, clientY: y, pointerId: 3, pointerType: "mouse"
    }));
    const state = window.__collage.slots[0];
    const m = window.__collage.placementFor(0);
    const bg = getComputedStyle(slot).backgroundPosition.split(" ").map(parseFloat);
    return {
      panX: state.panX,
      covers: m.bgW >= m.cw - 0.5 && m.bgH >= m.ch - 0.5,
      ox: Math.abs(bg[0] - m.ox) < 1.5,
      oy: Math.abs(bg[1] - m.oy) < 1.5
    };
  });
  assert(pan.panX > 0.5, "dragging the photo left reveals the right side (panX " + pan.panX + ")");
  assert(pan.covers, "panned photo still covers the cell");
  assert(pan.ox && pan.oy, "on-screen background position matches the cover math");

  const touchPan = await page.evaluate(async () => {
    const slot = document.querySelector('.slot[data-index="0"]');
    window.__collage.slots[0].zoom = 2;
    window.__collage.slots[0].panX = 0.5;
    window.__collage.slots[0].panY = 0.5;
    window.__collage.renderAll();
    const r = slot.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    function fire(type, dx, dy, id) {
      const target = type === "pointerdown" ? slot : document;
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x + dx,
        clientY: y + dy,
        pointerId: id,
        pointerType: "touch",
        button: 0
      }));
    }
    fire("pointerdown", 0, 0, 51);
    fire("pointermove", 0, -80, 51);
    fire("pointerup", 0, -80, 51);
    const afterVertical = {
      panX: window.__collage.slots[0].panX,
      panY: window.__collage.slots[0].panY,
      dragging: slot.classList.contains("dragging")
    };
    fire("pointerdown", 0, 0, 52);
    fire("pointermove", -70, 4, 52);
    const during = {
      dragging: slot.classList.contains("dragging"),
      touchAction: getComputedStyle(slot).touchAction
    };
    fire("pointerup", -70, 4, 52);
    const afterHorizontal = {
      panX: window.__collage.slots[0].panX,
      dragging: slot.classList.contains("dragging")
    };
    window.__collage.slots[0].panX = 0.5;
    window.__collage.slots[0].panY = 0.5;
    window.__collage.renderAll();
    fire("pointerdown", 0, 0, 53);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const held = {
      dragging: slot.classList.contains("dragging"),
      touchAction: getComputedStyle(slot).touchAction
    };
    fire("pointermove", 0, -60, 53);
    fire("pointerup", 0, -60, 53);
    return {
      afterVertical,
      during,
      afterHorizontal,
      held,
      panY: window.__collage.slots[0].panY,
      dragging: slot.classList.contains("dragging")
    };
  });
  assert(touchPan.afterVertical.panX === 0.5 && touchPan.afterVertical.panY === 0.5, "vertical touch swipe does not pan the photo " + JSON.stringify(touchPan.afterVertical));
  assert(!touchPan.afterVertical.dragging, "vertical swipe does not leave the slot dragging");
  assert(touchPan.during.dragging, "horizontal touch marks the slot dragging");
  assert(touchPan.during.touchAction === "none", "dragging slot uses touch-action none, got " + touchPan.during.touchAction);
  assert(touchPan.afterHorizontal.panX > 0.5, "horizontal touch pans the photo (panX " + touchPan.afterHorizontal.panX + ")");
  assert(!touchPan.afterHorizontal.dragging, "dragging class clears when the finger lifts");
  assert(touchPan.held.dragging && touchPan.held.touchAction === "none", "holding a photo starts a drag");
  assert(Math.abs(touchPan.panY - 0.5) > 0.02, "a drag after the hold can move the photo vertically (panY " + touchPan.panY + ")");
  assert(!touchPan.dragging, "hold drag clears when the finger lifts");

  const pinch = await page.evaluate(() => {
    const slot = document.querySelector('.slot[data-index="1"]');
    const r = slot.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const x1 = r.left + r.width / 2 - 30;
    const x2 = r.left + r.width / 2 + 30;
    function fire(type, id, x, target) {
      const ev = new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType: "touch", button: 0, isPrimary: id === 1
      });
      (target || slot).dispatchEvent(ev);
    }
    fire("pointerdown", 1, x1);
    fire("pointerdown", 2, x2);
    fire("pointermove", 1, x1 - 40, document);
    fire("pointermove", 2, x2 + 50, document);
    const zoom = window.__collage.slots[1].zoom;
    const m = window.__collage.placementFor(1);
    fire("pointerup", 1, x1 - 40, document);
    fire("pointerup", 2, x2 + 50, document);
    return { zoom, covers: m.bgW >= m.cw - 0.5 && m.bgH >= m.ch - 0.5, panX: window.__collage.slots[1].panX };
  });
  assert(pinch.zoom > 1.4 && pinch.zoom <= 3, "pinch zoom changes photo size, got " + pinch.zoom);
  assert(pinch.covers, "pinched photo still covers the cell");
  assert(pinch.panX >= 0 && pinch.panX <= 1, "pinch keeps pan inside the frame");

  await page.evaluate(() => {
    const seam = document.querySelector(".seam-v");
    const r = seam.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    seam.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 11, pointerType: "mouse", button: 0
    }));
    document.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: x - 70, clientY: y, pointerId: 11, pointerType: "mouse"
    }));
    document.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: x - 70, clientY: y, pointerId: 11, pointerType: "mouse"
    }));
    window.__collage.slots[0].panX = 0;
    window.__collage.slots[0].panY = 0.5;
    window.__collage.slots[0].zoom = 1;
    window.__collage.slots[1].panX = 1;
    window.__collage.slots[1].panY = 0.5;
    window.__collage.slots[1].zoom = 1;
    window.__collage.renderAll();
  });

  const exported = await page.evaluate(async () => {
    document.querySelectorAll(".zoom-bar, .remove-btn, .handles").forEach((el) => {
      el.style.visibility = "hidden";
    });
    const frame = document.getElementById("frame");
    frame.style.borderRadius = "0";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const fr = frame.getBoundingClientRect();
    const canvas = window.__collage.exportCollage();
    const ctx = canvas.getContext("2d");
    const jpeg = canvas.toDataURL("image/jpeg", 0.85);
    const img = new Image();
    img.src = jpeg;
    await img.decode();
    const round = document.createElement("canvas");
    round.width = canvas.width;
    round.height = canvas.height;
    const rctx = round.getContext("2d");
    rctx.drawImage(img, 0, 0);
    function sample(context, x, y) {
      const px = context.getImageData(x, y, 1, 1).data;
      return [px[0], px[1], px[2]];
    }
    const slots = [...document.querySelectorAll(".slot:not(.hidden)")].map((el) => {
      const r = el.getBoundingClientRect();
      const x = Math.round((r.left - fr.left + r.width * 0.5) * (canvas.width / fr.width));
      const y = Math.round((r.top - fr.top + r.height * 0.5) * (canvas.height / fr.height));
      return { x, y, color: sample(ctx, x, y), jpeg: sample(rctx, x, y), w: r.width, h: r.height };
    });
    const left = document.querySelector('.slot[data-index="0"]').getBoundingClientRect();
    const right = document.querySelector('.slot[data-index="1"]').getBoundingClientRect();
    const gapX = Math.round((left.right - fr.left + (right.left - left.right) / 2) * (canvas.width / fr.width));
    const gapY = Math.round((left.top - fr.top + left.height / 2) * (canvas.height / fr.height));
    const gap = sample(ctx, gapX, gapY);
    document.querySelectorAll(".zoom-bar, .remove-btn, .handles").forEach((el) => {
      el.style.visibility = "";
    });
    frame.style.borderRadius = "";
    return { slots, gap, canvasW: canvas.width, ratio: left.width / right.width };
  });
  assert(exported.slots[0].w < exported.slots[1].w, "export setup kept the resized cells");
  assert(colorNear(exported.slots[0].color, [239, 68, 68], 24), "left cell export shows the left of the panned photo " + exported.slots[0].color);
  assert(colorNear(exported.slots[1].color, [37, 99, 235], 24), "right cell export shows its photo " + exported.slots[1].color);
  assert(colorNear(exported.slots[0].jpeg, exported.slots[0].color, 20), "jpeg download matches the canvas");
  assert(colorNear(exported.gap, [194, 29, 46], 20), "gap between resized cells stays the border color " + exported.gap);
  assert(exported.ratio < 0.85, "left cell is visibly narrower in the export geometry");

  const screenMatch = await compareFrameToExport(page);
  assert(screenMatch.maxInterior < 18, "export interior should match the screen, max channel diff " + screenMatch.maxInterior);
  assert(screenMatch.meanInterior < 8, "export mean interior diff " + screenMatch.meanInterior);

  const controls = await page.evaluate(() => {
    const remove = document.querySelector('#clearRow [data-action="remove"][data-slot="1"]');
    const rr = remove.getBoundingClientRect();
    const hit = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2);
    const slider = document.querySelector('#sizeRail [data-action="zoom"][data-slot="1"]');
    const sr = slider.getBoundingClientRect();
    const sliderHit = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
    return {
      remove: hit === remove || remove.contains(hit),
      slider: sliderHit === slider || slider.contains(sliderHit)
    };
  });
  assert(controls.remove, "remove button stays clickable outside the frame");
  assert(controls.slider, "size slider stays usable above the handles");

  await page.click('#clearRow [data-action="remove"][data-slot="1"]');
  const removed = await page.evaluate(() => {
    const slot = window.__collage.slots[1];
    return !slot.img && !document.querySelector('.slot[data-index="1"]').classList.contains("filled");
  });
  assert(removed, "remove photo still clears the cell");

  const border = await page.evaluate(() => {
    const input = document.getElementById("borderWidth");
    input.value = "12";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const width = getComputedStyle(document.documentElement).getPropertyValue("--border-width").trim();
    document.querySelector('.swatch[data-color="#111111"]').click();
    const color = getComputedStyle(document.documentElement).getPropertyValue("--border-color").trim();
    document.querySelector('[data-shape="shape-landscape"]').click();
    const shape = document.getElementById("frame").classList.contains("shape-landscape");
    document.getElementById("resetBorderBtn").click();
    const resetWidth = getComputedStyle(document.documentElement).getPropertyValue("--border-width").trim();
    const resetColor = getComputedStyle(document.documentElement).getPropertyValue("--border-color").trim();
    return { width, color, shape, resetWidth, resetColor };
  });
  assert(border.width === "12px", "border thickness still applies");
  assert(border.color === "#111111", "border color still applies");
  assert(border.shape, "canvas shape still applies");
  assert(border.resetWidth === "3px" && border.resetColor === "#c21d2e", "reset border restores defaults");

  const alerts = [];
  page.on("dialog", async (dialog) => {
    alerts.push(dialog.message());
    await dialog.accept();
  });
  await page.evaluate(() => {
    window.__collage.slots.forEach((slot) => {
      slot.img = null;
      slot.dataURL = null;
      window.__collage.renderAll();
    });
  });
  await page.click("#downloadBtn");
  assert(alerts.length === 1 && alerts[0].includes("Add at least one photo"), "empty download still warns");

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluate(() => {
    window.__collage.applyLayout("2v");
    window.__collage.resetCells();
    window.scrollTo(0, 0);
  });
  const emptyPoint = await slotPoint(page, '.slot[data-index="0"]', 0.35, 0.4);
  const emptySwipe = await touchSwipe(page, emptyPoint.x, emptyPoint.y, 0, -170, 0);
  assert(emptySwipe.scroll > emptySwipe.before + 30, "vertical swipe on an empty cell scrolls the page (" + emptySwipe.before + " -> " + emptySwipe.scroll + ")");
  await settleScroll(page);

  await page.evaluate(async (redUrl, blueUrl) => {
    window.__collage.applyLayout("2v");
    window.__collage.resetCells();
    await window.__collage.loadDataURL(0, redUrl);
    await window.__collage.loadDataURL(1, blueUrl);
    window.__collage.slots[0].zoom = 1;
    window.__collage.slots[0].panX = 0.5;
    window.__collage.slots[0].panY = 0.5;
    window.__collage.renderAll();
  }, red, blue);
  await page.waitForSelector(".seam-v");
  await settleScroll(page);

  const filledPoint = await slotPoint(page, '.slot[data-index="0"]', 0.35, 0.42);
  const filledSwipe = await touchSwipe(page, filledPoint.x, filledPoint.y, 0, -170, 0);
  assert(filledSwipe.scroll > 30, "vertical swipe over a photo scrolls the page (" + filledSwipe.scroll + ")");
  near(filledSwipe.panX, 0.5, 0.02, "vertical swipe over a photo does not pan it sideways");
  near(filledSwipe.panY, 0.5, 0.02, "vertical swipe over a photo does not pan it");
  await settleScroll(page);

  const horizontalPoint = await slotPoint(page, '.slot[data-index="0"]', 0.55, 0.42);
  const horizontalSwipe = await touchSwipe(page, horizontalPoint.x, horizontalPoint.y, -110, 0, 0);
  assert(horizontalSwipe.panX > 0.55, "sideways touch on a photo pans it (panX " + horizontalSwipe.panX + ")");
  assert(horizontalSwipe.scroll < 20, "sideways photo drag does not scroll the page");
  assert(!horizontalSwipe.dragging, "photo drag releases cleanly on touch end");
  await settleScroll(page);

  await page.evaluate(() => {
    window.__collage.slots[0].zoom = 2;
    window.__collage.slots[0].panX = 0.5;
    window.__collage.slots[0].panY = 0.5;
    window.__collage.renderAll();
    window.scrollTo(0, 0);
  });
  const holdPoint = await slotPoint(page, '.slot[data-index="0"]', 0.35, 0.42);
  const holdSwipe = await touchSwipe(page, holdPoint.x, holdPoint.y, 0, -90, 280);
  assert(Math.abs(holdSwipe.panY - 0.5) > 0.02, "holding then dragging pans the photo (panY " + holdSwipe.panY + ")");
  assert(holdSwipe.scroll < 20, "a held photo drag does not scroll the page");
  await settleScroll(page);
  await page.evaluate(() => {
    window.__collage.slots[0].zoom = 1;
    window.__collage.slots[0].panX = 0.5;
    window.__collage.slots[0].panY = 0.5;
    window.__collage.renderAll();
  });

  const mobileBefore = await cellWidths(page);
  const touchBox = await page.$eval(".seam-v", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
  });
  assert(touchBox.w >= 28, "touch handle is large enough, width " + touchBox.w);
  const client = await page.createCDPSession();
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: touchBox.x, y: touchBox.y, id: 1 }]
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: touchBox.x + 50, y: touchBox.y, id: 1 }]
  });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const mobileAfter = await cellWidths(page);
  assert(mobileAfter[0] > mobileBefore[0] + 25, "touch drag resizes adjacent cells (" + mobileBefore[0] + " -> " + mobileAfter[0] + ")");

  const mobilePinch = await page.evaluate(() => {
    const slot = document.querySelector('.slot[data-index="0"]');
    const r = slot.getBoundingClientRect();
    const y = r.top + 70;
    const mid = r.left + r.width / 2;
    function fire(type, id, x) {
      document.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType: "touch", button: 0
      }));
    }
    slot.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: mid - 24, clientY: y, pointerId: 21, pointerType: "touch", button: 0
    }));
    slot.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: mid + 24, clientY: y, pointerId: 22, pointerType: "touch", button: 0
    }));
    fire("pointermove", 21, mid - 70);
    fire("pointermove", 22, mid + 70);
    const zoom = window.__collage.slots[0].zoom;
    const m = window.__collage.placementFor(0);
    fire("pointerup", 21, mid - 70);
    fire("pointerup", 22, mid + 70);
    return { zoom, covers: m.bgW >= m.cw - 0.5 && m.bgH >= m.ch - 0.5 };
  });
  assert(mobilePinch.zoom > 1.5, "mobile pinch zooms, got " + mobilePinch.zoom);
  assert(mobilePinch.covers, "mobile pinch keeps the photo covering the cell");

  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
  });
  assert(overflow, "mobile layout should not overflow horizontally");

  const tight = await page.evaluate(() => {
    window.__collage.applyLayout("5v");
    document.documentElement.style.setProperty("--border-width", "28px");
    const widths = [...document.querySelectorAll(".slot:not(.hidden)")].map((el) => el.getBoundingClientRect().width);
    document.getElementById("resetBorderBtn").click();
    window.__collage.applyLayout("4");
    const seams = window.__collage.seams();
    const h = document.querySelector(".seam-h").getBoundingClientRect();
    seamDrag(document.querySelector(".seam-h"), 0, 40);
    const heights = [...document.querySelectorAll(".slot:not(.hidden)")].map((el) => el.getBoundingClientRect().height);
    return { widths, seams: seams.length, h: h.height, top: heights[0], bottom: heights[2] };
    function seamDrag(el, dx, dy) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 30, pointerType: "touch", button: 0
      }));
      document.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, clientX: x + dx, clientY: y + dy, pointerId: 30, pointerType: "touch"
      }));
      document.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, clientX: x + dx, clientY: y + dy, pointerId: 30, pointerType: "touch"
      }));
    }
  });
  assert(tight.widths.length === 5 && tight.widths.every((w) => w > 8), "five-up cells stay visible with a thick border " + tight.widths);
  assert(tight.seams === 2, "four-up layout has both dividers");
  assert(tight.top > tight.bottom, "vertical divider drag resizes the rows above and below");

  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1, hasTouch: true, isMobile: false });
  await settleScroll(page);
  const quad = await paint(page, (ctx, w, h) => {
    ctx.fillStyle = "#e11d48";
    ctx.fillRect(0, 0, w / 2, h / 2);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(w / 2, 0, w / 2, h / 2);
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(0, h / 2, w / 2, h / 2);
    ctx.fillStyle = "#facc15";
    ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
  }, 800, 800);
  const purple = await paint(page, (ctx, w, h) => {
    ctx.fillStyle = "#7c3aed";
    ctx.fillRect(0, 0, w, h);
  }, 240, 240);
  const lsExport = await page.evaluate(async (redUrl, purpleUrl, quadUrl) => {
    window.__collage.applyLayout("ls");
    window.__collage.resetCells();
    document.getElementById("resetBorderBtn").click();
    document.querySelector('[data-shape="shape-square"]').click();
    await window.__collage.loadDataURL(0, redUrl);
    await window.__collage.loadDataURL(1, purpleUrl);
    const slot = document.querySelector('.slot[data-index="0"]');
    const input = document.querySelector('#sizeRail [data-action="zoom"][data-slot="0"]');
    input.value = "160";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const r = slot.getBoundingClientRect();
    const px = r.left + r.width * 0.3;
    const py = r.top + r.height * 0.2;
    slot.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: -80, clientX: px, clientY: py
    }));
    slot.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: px, clientY: py, pointerId: 81, pointerType: "mouse", button: 0
    }));
    document.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: px - 50, clientY: py, pointerId: 81, pointerType: "mouse"
    }));
    document.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: px - 50, clientY: py, pointerId: 81, pointerType: "mouse"
    }));
    const placed = window.__collage.placementFor(0);
    const gesture = {
      zoom: window.__collage.slots[0].zoom,
      panX: window.__collage.slots[0].panX,
      covers: placed.bgW >= placed.cw - 0.5 && placed.bgH >= placed.ch - 0.5
    };
    await window.__collage.loadDataURL(0, quadUrl);
    window.__collage.slots[0].zoom = 1;
    window.__collage.slots[0].panX = 0.5;
    window.__collage.slots[0].panY = 0.5;
    window.__collage.renderAll();
    const frame = document.getElementById("frame");
    const fr = frame.getBoundingClientRect();
    const canvas = window.__collage.exportCollage();
    const ctx = canvas.getContext("2d");
    function sample(xRatio, yRatio) {
      const sx = Math.round(fr.width * xRatio * (canvas.width / fr.width));
      const sy = Math.round(fr.height * yRatio * (canvas.height / fr.height));
      const px = ctx.getImageData(Math.max(0, Math.min(canvas.width - 1, sx)), Math.max(0, Math.min(canvas.height - 1, sy)), 1, 1).data;
      return [px[0], px[1], px[2]];
    }
    return {
      gesture,
      topLeft: sample(0.25, 0.25),
      topRight: sample(0.75, 0.22),
      bottomLeft: sample(0.22, 0.75),
      square: sample(0.75, 0.78)
    };
  }, red, purple, quad);
  assert(lsExport.gesture.zoom > 1.6 && lsExport.gesture.zoom <= 3, "L photo still zooms, got " + lsExport.gesture.zoom);
  assert(lsExport.gesture.panX > 0.5, "L photo still pans, panX " + lsExport.gesture.panX);
  assert(lsExport.gesture.covers, "zoomed L photo still covers its cell");
  assert(colorNear(lsExport.topLeft, [225, 29, 72], 24), "export top-left of the L shows that photo " + lsExport.topLeft);
  assert(colorNear(lsExport.topRight, [22, 163, 74], 24), "export top-right is part of the L photo " + lsExport.topRight);
  assert(colorNear(lsExport.bottomLeft, [37, 99, 235], 24), "export bottom-left is part of the L photo " + lsExport.bottomLeft);
  assert(colorNear(lsExport.square, [124, 58, 237], 24), "export square shows its own photo " + lsExport.square);

  const portrait = await paint(page, (ctx, w, h) => {
    ctx.fillStyle = "#7f1d1d";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#fdba74";
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w * 0.22, h * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
  }, 600, 800);
  const uniformZoom = await page.evaluate(async (photoUrl) => {
    window.__collage.applyLayout("ls");
    window.__collage.resetCells();
    await window.__collage.loadDataURL(0, photoUrl);
    await window.__collage.loadDataURL(1, photoUrl);
    function snap(zL, zSq) {
      window.__collage.slots[0].zoom = zL;
      window.__collage.slots[1].zoom = zSq;
      window.__collage.slots[0].panX = 0.5;
      window.__collage.slots[0].panY = 0.5;
      window.__collage.slots[1].panX = 0.5;
      window.__collage.slots[1].panY = 0.5;
      window.__collage.renderAll();
      const l = window.__collage.placementFor(0);
      const sq = window.__collage.placementFor(1);
      const exported = window.__collage.exportCollage();
      const ctx = exported.getContext("2d");
      const fr = document.getElementById("frame").getBoundingClientRect();
      const slot = document.querySelector('.slot[data-index="1"]').getBoundingClientRect();
      const sx = Math.round((slot.left - fr.left + slot.width * 0.5) * (exported.width / fr.width));
      const sy = Math.round((slot.top - fr.top + slot.height * 0.5) * (exported.height / fr.height));
      const px = ctx.getImageData(sx, sy, 1, 1).data;
      return {
        l: l.total,
        sq: sq.total,
        covers: sq.bgW >= sq.cw - 0.5 && sq.bgH >= sq.ch - 0.5,
        seen: sq.ch / sq.bgH,
        exportCenter: [px[0], px[1], px[2]]
      };
    }
    const same = snap(2, 2);
    const punched = snap(1, 3);
    for (let i = 0; i < 5; i++) await window.__collage.loadDataURL(i, photoUrl);
    const layouts = {};
    ["ls", "2v", "2h", "3v", "4v", "5v", "3l", "3t", "4"].forEach((key) => {
      window.__collage.applyLayout(key);
      window.__collage.resetCells();
      const visible = window.__collage.slots.filter((slot) => !slot.el.classList.contains("hidden"));
      visible.forEach((slot) => {
        slot.zoom = 2;
        slot.panX = 0.5;
        slot.panY = 0.5;
      });
      window.__collage.renderAll();
      const placed = visible.map((slot) => window.__collage.placementFor(window.__collage.slots.indexOf(slot)));
      layouts[key] = {
        totals: placed.map((m) => m.total),
        covers: placed.every((m) => m.bgW >= m.cw - 0.5 && m.bgH >= m.ch - 0.5)
      };
    });
    window.__collage.applyLayout("2v");
    window.__collage.resetCells();
    window.__collage.slots[0].zoom = 2;
    window.__collage.slots[1].zoom = 2;
    window.__collage.renderAll();
    const even = window.__collage.placementFor(0);
    const own = Math.max(even.cw / even.iw, even.ch / even.ih) * 2;
    const seam = document.querySelector(".seam-v");
    const r = seam.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    seam.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 91, pointerType: "mouse", button: 0
    }));
    document.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: x + 80, clientY: y, pointerId: 91, pointerType: "mouse"
    }));
    document.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: x + 80, clientY: y, pointerId: 91, pointerType: "mouse"
    }));
    window.__collage.slots[0].zoom = 2;
    window.__collage.slots[1].zoom = 2;
    window.__collage.renderAll();
    const uneven = {
      a: window.__collage.placementFor(0).total,
      b: window.__collage.placementFor(1).total,
      aw: window.__collage.placementFor(0).cw,
      bw: window.__collage.placementFor(1).cw
    };
    window.__collage.slots.forEach((slot) => {
      slot.img = null;
      slot.dataURL = null;
      slot.zoom = 1;
      slot.panX = 0.5;
      slot.panY = 0.5;
    });
    window.__collage.resetCells();
    window.__collage.renderAll();
    window.__collage.applyLayout("2v");
    return { same, punched, layouts, own, even: even.total, uneven };
  }, portrait);
  near(uniformZoom.same.sq, uniformZoom.same.l, uniformZoom.same.l * 0.02, "equal Size uses the same photo scale on the L and the square");
  assert(uniformZoom.same.covers, "square photo still covers the small cell");
  assert(uniformZoom.same.seen < 0.7, "square shows a tighter crop than a shrunk full photo, seen " + uniformZoom.same.seen);
  assert(uniformZoom.punched.sq > uniformZoom.punched.l * 2.8, "max Size on the square punches in much further than the L at 100% (" + uniformZoom.punched.sq + " vs " + uniformZoom.punched.l + ")");
  near(uniformZoom.even, uniformZoom.own, uniformZoom.own * 0.02, "equal half-half cells still cover-fit themselves");
  assert(Math.abs(uniformZoom.uneven.aw - uniformZoom.uneven.bw) > 40, "seam drag made the half-half cells unequal");
  near(uniformZoom.uneven.a, uniformZoom.uneven.b, uniformZoom.uneven.a * 0.02, "unequal cells keep the same Size scale");
  Object.keys(uniformZoom.layouts).forEach((key) => {
    const row = uniformZoom.layouts[key];
    const hi = Math.max(...row.totals);
    const lo = Math.min(...row.totals);
    assert(row.covers, key + " photos still cover their cells");
    near(lo, hi, hi * 0.02, key + " cells share one Size scale " + row.totals.join(","));
  });
  assert(colorNear(uniformZoom.same.exportCenter, [253, 186, 116], 12), "exported square uses the same centered crop " + uniformZoom.same.exportCenter);

  await page.evaluate(async (redUrl, blueUrl, bandsUrl) => {
    window.__collage.applyLayout("4");
    window.__collage.resetCells();
    document.getElementById("resetBorderBtn").click();
    document.querySelector('[data-shape="shape-portrait"]').click();
    await window.__collage.loadDataURL(0, bandsUrl);
    await window.__collage.loadDataURL(1, redUrl);
    await window.__collage.loadDataURL(2, blueUrl);
    await window.__collage.loadDataURL(3, redUrl);
    const v = document.querySelector(".seam-v");
    const h = document.querySelector(".seam-h");
    drag(v, 55, 0);
    drag(h, 0, 40);
    window.__collage.slots[0].zoom = 1.6;
    window.__collage.slots[0].panX = 0.15;
    window.__collage.slots[0].panY = 0.4;
    window.__collage.renderAll();
    function drag(el, dx, dy) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 40, pointerType: "mouse", button: 0
      }));
      document.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, clientX: x + dx, clientY: y + dy, pointerId: 40, pointerType: "mouse"
      }));
      document.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, clientX: x + dx, clientY: y + dy, pointerId: 40, pointerType: "mouse"
      }));
    }
  }, red, blue, bands);

  const desktopWidths = await cellWidths(page);
  const desktopSeam = await page.$eval(".seam-v", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const desktopClient = await page.createCDPSession();
  await desktopClient.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: Math.round(desktopSeam.x), y: Math.round(desktopSeam.y), id: 1 }]
  });
  await desktopClient.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: Math.round(desktopSeam.x + 40), y: Math.round(desktopSeam.y), id: 1 }]
  });
  await desktopClient.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await desktopClient.detach();
  const desktopWidthsAfter = await cellWidths(page);
  assert(desktopWidthsAfter[0] > desktopWidths[0] + 20, "desktop touch drag resizes the divider (" + desktopWidths[0] + " -> " + desktopWidthsAfter[0] + ")");

  await page.evaluate(() => {
    window.__collage.slots[0].zoom = 1.8;
    window.__collage.slots[0].panX = 0.5;
    window.__collage.slots[0].panY = 0.5;
    window.__collage.renderAll();
    window.scrollTo(0, 0);
  });
  const desktopPhoto = await slotPoint(page, '.slot[data-index="0"]', 0.45, 0.35);
  const desktopPhotoDrag = await touchSwipe(page, desktopPhoto.x, desktopPhoto.y, -80, 0, 0);
  assert(desktopPhotoDrag.panX > 0.55, "desktop emulated touch pans a photo sideways (panX " + desktopPhotoDrag.panX + ")");
  const desktopZoom = await page.evaluate(() => {
    const slot = document.querySelector('.slot[data-index="0"]');
    const r = slot.getBoundingClientRect();
    const y = r.top + r.height * 0.35;
    const mid = r.left + r.width * 0.45;
    function fire(type, id, x, target) {
      (target || slot).dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType: "touch", button: 0
      }));
    }
    fire("pointerdown", 61, mid - 20);
    fire("pointerdown", 62, mid + 20);
    fire("pointermove", 61, mid - 70, document);
    fire("pointermove", 62, mid + 70, document);
    const zoom = window.__collage.slots[0].zoom;
    fire("pointerup", 61, mid - 70, document);
    fire("pointerup", 62, mid + 70, document);
    window.__collage.slots[0].zoom = 1.6;
    window.__collage.slots[0].panX = 0.15;
    window.__collage.slots[0].panY = 0.4;
    window.__collage.renderAll();
    return zoom;
  });
  assert(desktopZoom > 1.8, "desktop emulated touch pinch zooms the photo, got " + desktopZoom);

  await mkdir(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, "desktop-resized-collage.png"), fullPage: true });
  const preview = await page.evaluate(() => {
    const canvas = window.__collage.exportCollage();
    return canvas.toDataURL("image/jpeg", 0.85);
  });
  const previewBuf = Buffer.from(preview.split(",")[1], "base64");
  await writeFile(join(shotDir, "export-resized-collage.jpg"), previewBuf);

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(shotDir, "mobile-resized-collage.png") });

  assert(pageErrors.length === 0, "page errors: " + pageErrors.join(" | "));
  console.log("collage tests passed");
  console.log("screenshots in " + shotDir);
} catch (err) {
  await mkdir(shotDir, { recursive: true });
  try {
    await page.screenshot({ path: join(shotDir, "failure.png"), fullPage: true });
  } catch (shotErr) {
    console.error(shotErr);
  }
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

async function slotPoint(page, selector, xRatio, yRatio) {
  return page.$eval(selector, (el, xRatio, yRatio) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * xRatio, y: r.top + r.height * yRatio };
  }, xRatio, yRatio);
}

async function touchSwipe(page, x, y, dx, dy, holdMs) {
  const client = await page.createCDPSession();
  const before = await page.evaluate(() => window.scrollY);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1 }]
  });
  if (holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x: Math.round(x + (dx * i) / steps),
        y: Math.round(y + (dy * i) / steps),
        id: 1
      }]
    });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const after = await page.evaluate(() => ({
    scroll: window.scrollY,
    panX: window.__collage.slots[0].panX,
    panY: window.__collage.slots[0].panY,
    dragging: document.querySelector('.slot[data-index="0"]').classList.contains("dragging")
  }));
  await client.detach();
  return { before, ...after };
}

async function settleScroll(page) {
  await new Promise((resolve) => setTimeout(resolve, 450));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((resolve) => setTimeout(resolve, 40));
}

async function cellWidths(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll(".slot:not(.hidden)")].map((el) => el.getBoundingClientRect().width);
  });
}

async function paint(page, draw, w, h) {
  const src = draw.toString();
  return page.evaluate((fnSrc, w, h) => {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.canvas.width = w;
    ctx.canvas.height = h;
    const fn = eval("(" + fnSrc + ")");
    fn(ctx, w, h);
    return ctx.canvas.toDataURL("image/png");
  }, src, w, h);
}

function colorNear(actual, expected, tol) {
  return actual.every((channel, i) => Math.abs(channel - expected[i]) <= tol);
}

async function compareFrameToExport(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".zoom-bar, .remove-btn, .handles").forEach((el) => {
      el.style.visibility = "hidden";
    });
    document.getElementById("frame").style.borderRadius = "0";
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const handle = await page.$("#frame");
  const shot = await handle.screenshot({ encoding: "base64" });
  const result = await page.evaluate(async (b64) => {
    const frame = document.getElementById("frame");
    const fr = frame.getBoundingClientRect();
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const screen = document.createElement("canvas");
    screen.width = img.width;
    screen.height = img.height;
    const sctx = screen.getContext("2d");
    sctx.drawImage(img, 0, 0);
    const exported = window.__collage.exportCollage();
    const scaled = document.createElement("canvas");
    scaled.width = img.width;
    scaled.height = img.height;
    const ectx = scaled.getContext("2d");
    ectx.imageSmoothingEnabled = true;
    ectx.drawImage(exported, 0, 0, img.width, img.height);
    const slots = [...document.querySelectorAll(".slot:not(.hidden)")];
    let maxInterior = 0;
    let sum = 0;
    let n = 0;
    slots.forEach((el) => {
      const r = el.getBoundingClientRect();
      [0.35, 0.5, 0.65].forEach((px) => {
        [0.35, 0.5, 0.65].forEach((py) => {
          const x = Math.round((r.left - fr.left + r.width * px) * (img.width / fr.width));
          const y = Math.round((r.top - fr.top + r.height * py) * (img.height / fr.height));
          const a = sctx.getImageData(clampPx(x, img.width), clampPx(y, img.height), 1, 1).data;
          const b = ectx.getImageData(clampPx(x, img.width), clampPx(y, img.height), 1, 1).data;
          const diff = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
          maxInterior = Math.max(maxInterior, diff);
          sum += diff;
          n += 1;
        });
      });
    });
    document.querySelectorAll(".zoom-bar, .remove-btn, .handles").forEach((el) => {
      el.style.visibility = "";
    });
    frame.style.borderRadius = "";
    return { maxInterior, meanInterior: sum / n, shot: [img.width, img.height], frame: [fr.width, fr.height] };
    function clampPx(v, limit) {
      return Math.max(0, Math.min(limit - 1, v));
    }
  }, shot);
  return result;
}
