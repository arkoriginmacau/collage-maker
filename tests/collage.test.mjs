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

  const seamPlan = await page.evaluate(() => {
    const keys = ["1", "2v", "2h", "3v", "4v", "5v", "3l", "3t", "4"];
    const out = {};
    keys.forEach((key) => {
      window.__collage.applyLayout(key);
      out[key] = window.__collage.seams().map((s) => s.axis + ":" + s.index + ":" + s.start + "-" + s.end);
    });
    window.__collage.applyLayout("2v");
    return out;
  });
  assert(seamPlan["1"].length === 0, "layout 1 has no seams");
  assert(JSON.stringify(seamPlan["2v"]) === JSON.stringify(["v:0:0-1"]), "2v seam " + seamPlan["2v"]);
  assert(JSON.stringify(seamPlan["2h"]) === JSON.stringify(["h:0:0-1"]), "2h seam " + seamPlan["2h"]);
  assert(seamPlan["3v"].length === 2 && seamPlan["3v"].every((s) => s.startsWith("v:")), "3v seams");
  assert(seamPlan["4v"].length === 3, "4v seams");
  assert(seamPlan["5v"].length === 4, "5v seams");
  assert(JSON.stringify(seamPlan["3l"]) === JSON.stringify(["v:0:0-2", "h:0:1-2"]), "3l seams " + seamPlan["3l"]);
  assert(JSON.stringify(seamPlan["3t"]) === JSON.stringify(["v:0:1-2", "h:0:0-2"]), "3t seams " + seamPlan["3t"]);
  assert(JSON.stringify(seamPlan["4"]) === JSON.stringify(["v:0:0-2", "h:0:0-2"]), "4 seams " + seamPlan["4"]);

  const resetDisabledOnSingle = await page.evaluate(() => {
    window.__collage.applyLayout("1");
    const disabled = document.getElementById("resetCellsBtn").disabled;
    const hidden = document.querySelectorAll(".slot.hidden").length;
    window.__collage.applyLayout("2v");
    return { disabled, hidden };
  });
  assert(resetDisabledOnSingle.disabled, "reset sizes disabled for one cell");
  assert(resetDisabledOnSingle.hidden === 4, "single layout hides the other slots");

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
    const input = document.querySelector('.slot[data-index="0"] [data-action="zoom"]');
    input.value = "180";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return window.__collage.slots[0].zoom;
  });
  near(sliderZoom, 1.8, 0.001, "size slider sets zoom");

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
    const remove = document.querySelector('.slot[data-index="1"] .remove-btn');
    const rr = remove.getBoundingClientRect();
    const hit = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2);
    const slider = document.querySelector('.slot[data-index="1"] [data-action="zoom"]');
    const sr = slider.getBoundingClientRect();
    const sliderHit = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
    return {
      remove: hit === remove,
      slider: sliderHit === slider || slider.contains(sliderHit)
    };
  });
  assert(controls.remove, "remove button stays clickable above the handles");
  assert(controls.slider, "size slider stays usable above the handles");

  await page.click('.slot[data-index="1"] .remove-btn');
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
