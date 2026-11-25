/**
 * Browser end-to-end test of the actual 进房 button on the example page.
 *
 * Unlike map-room-queue.test.ts (which drives the SDK directly), this opens
 * the real page in headless Chromium, clicks the rendered 进房 button in two
 * browsers, and reads the painted <canvas> pixels to count the circles and
 * locate their centers.
 *
 * Requires a running Vite dev server and a reachable Chrome binary. Example:
 *   pnpm --filter @colyseus/example run vite          # note the printed port
 *   E2E_BASE=http://[::1]:5173 \
 *   E2E_CHROME_PATH=/path/to/chrome-headless-shell \
 *   pnpm exec tsx --test --test-force-exit test/map-room-browser.test.ts
 * The test skips itself when E2E_BASE is not set or unreachable.
 */
import assert from 'node:assert';
import { describe, it, before, after } from 'node:test';
import puppeteer, { type Browser, type Page } from 'puppeteer';

const BASE = process.env.E2E_BASE ?? '';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DetectedCircle { x: number; y: number; color: 'blue' | 'grey' }

/**
 * Run inside the page: scan the 800x600 canvas, label connected components of
 * circle-colored pixels (own blue #2563eb, other grey #6b7280), and return
 * each component's centroid and color. Text labels (#9ca3af) and the dark
 * background (#030712) are deliberately outside the color gates.
 */
/**
 * Raw browser code, kept as a string so the Node test runner's loader does not
 * inject its `__name`/`__publicField` helpers into code that runs in Chrome.
 * It scans the 800x600 canvas, labels connected components of circle-colored
 * pixels (own blue #2563eb, other grey #6b7280), and returns each component's
 * centroid and color. Text labels (#9ca3af) and the dark background are
 * outside the color gates.
 */
const DETECT_CIRCLES_FN = `
  (function () {
    var canvas = document.querySelector('#game');
    var ctx = canvas.getContext('2d');
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var width = img.width, height = img.height, data = img.data;

    function kindAt(i) {
      var r = data[i], g = data[i + 1], b = data[i + 2];
      if (b > 150 && b > r + 50) return 1; // own blue circle
      if (Math.abs(r - 107) < 40 && Math.abs(g - 114) < 40 && Math.abs(b - 128) < 40) return 2; // grey
      return 0;
    }

    var labels = new Int32Array(width * height);
    var circles = [];

    for (var py = 0; py < height; py++) {
      for (var px = 0; px < width; px++) {
        var idx = py * width + px;
        if (labels[idx] || kindAt(idx * 4) === 0) { continue; }

        var want = kindAt(idx * 4);
        var color = want === 1 ? 'blue' : 'grey';
        var label = circles.length + 1;
        var stack = [idx];
        var sx = 0, sy = 0, n = 0;
        labels[idx] = label;
        while (stack.length) {
          var cur = stack.pop();
          var cx = cur % width, cy = (cur / width) | 0;
          sx += cx; sy += cy; n++;
          var neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
          for (var k = 0; k < neighbors.length; k++) {
            var nx = neighbors[k][0], ny = neighbors[k][1];
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) { continue; }
            var ni = ny * width + nx;
            if (!labels[ni] && kindAt(ni * 4) === want) {
              labels[ni] = label;
              stack.push(ni);
            }
          }
        }
        circles.push({ sx: sx, sy: sy, n: n, color: color });
      }
    }

    return circles
      .filter(function (c) { return c.n > 100; })
      .map(function (c) { return { x: c.sx / c.n, y: c.sy / c.n, color: c.color }; });
  })()`;

async function detectCircles(page: Page): Promise<DetectedCircle[]> {
  // evaluate the raw source string — no bundler helper references.
  return (await page.evaluate(`(${DETECT_CIRCLES_FN})`)) as DetectedCircle[];
}

async function statusText(page: Page): Promise<string> {
  return await page.$eval('#status', (el) => el.textContent ?? '');
}

async function clickJoin(page: Page) {
  await page.click('#connect');
}

let browser: Browser | null = null;
// Evaluated at module load (describe's skip flag is read at collection time).
const reachable = await fetch(BASE).then((r) => r.ok).catch(() => false);

before(async () => {
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 30_000,
    // Allow a system/full Chrome or the bundled headless-shell. When unset,
    // Puppeteer uses its default downloaded browser.
    ...(process.env.E2E_CHROME_PATH ? { executablePath: process.env.E2E_CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
});

after(async () => {
  if (browser) { await browser.close(); }
});

describe('进房 button (browser E2E)', { skip: !reachable }, () => {
  it('two browsers both end in the same room and each canvas paints two circles at matching centers', async () => {
    const pageA = await browser!.newPage();
    const pageB = await browser!.newPage();
    pageA.on('pageerror', (e: unknown) => process.stderr.write(`[pageA error] ${(e as Error).message}\n`));
    pageB.on('pageerror', (e: unknown) => process.stderr.write(`[pageB error] ${(e as Error).message}\n`));

    await pageA.goto(`${BASE}/?rank=10`, { waitUntil: 'domcontentloaded' });
    await pageB.goto(`${BASE}/?rank=12`, { waitUntil: 'domcontentloaded' });

    // First player queues alone: no circle is painted while unseated.
    await clickJoin(pageA);
    await wait(1200);
    assert.equal((await detectCircles(pageA)).length, 0, 'no circle before being seated');

    await clickJoin(pageB);

    // Wait for both pages to reach the connected state.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [a, b] = await Promise.all([statusText(pageA), statusText(pageB)]);
      if (a.includes('房间') && b.includes('房间')) { break; }
      await wait(200);
    }
    const [sa, sb] = await Promise.all([statusText(pageA), statusText(pageB)]);
    assert.ok(sa.includes('房间'), `page A connected (got: ${sa})`);
    assert.ok(sb.includes('房间'), `page B connected (got: ${sb})`);

    // Same room id shown in both status lines.
    const roomIdOf = (s: string) => (s.match(/房间\s+(\S+)/) ?? [])[1];
    assert.equal(roomIdOf(sa), roomIdOf(sb), 'both browsers joined the same room');

    // Give the state patch a moment to render, then read both canvases.
    await wait(500);
    const [circlesA, circlesB] = await Promise.all([detectCircles(pageA), detectCircles(pageB)]);
    assert.equal(circlesA.length, 2, 'first canvas paints two circles');
    assert.equal(circlesB.length, 2, 'second canvas paints two circles');

    // Each canvas: one blue (self), one grey (other).
    assert.equal(circlesA.filter((c) => c.color === 'blue').length, 1);
    assert.equal(circlesA.filter((c) => c.color === 'grey').length, 1);
    assert.equal(circlesB.filter((c) => c.color === 'blue').length, 1);
    assert.equal(circlesB.filter((c) => c.color === 'grey').length, 1);

    // The two canvases paint the same centers (same room-recorded coordinates).
    const key = (c: DetectedCircle) => `${Math.round(c.x)},${Math.round(c.y)}`;
    const keysA = new Set(circlesA.map(key));
    for (const c of circlesB) {
      assert.ok(keysA.has(key(c)), `center ${key(c)} appears on both canvases`);
    }

    await pageA.close();
    await pageB.close();
  });

  it('capacity=1: one browser seats with a single circle, the other is rejected and paints nothing', async () => {
    const pageA = await browser!.newPage();
    const pageB = await browser!.newPage();

    await pageA.goto(`${BASE}/?capacity=1&rank=10`, { waitUntil: 'domcontentloaded' });
    await pageB.goto(`${BASE}/?capacity=1&rank=12`, { waitUntil: 'domcontentloaded' });

    await Promise.all([clickJoin(pageA), clickJoin(pageB)]);

    // Resolve which page got the single seat and which was rejected.
    const deadline = Date.now() + 15_000;
    let seated: Page | null = null;
    let rejected: Page | null = null;
    while (Date.now() < deadline) {
      const [a, b] = await Promise.all([statusText(pageA), statusText(pageB)]);
      const seatedA = a.includes('房间'), seatedB = b.includes('房间');
      const rejectedA = a.includes('被拒绝'), rejectedB = b.includes('被拒绝');
      if ((seatedA && rejectedB) || (seatedB && rejectedA)) {
        seated = seatedA ? pageA : pageB;
        rejected = rejectedA ? pageA : pageB;
        break;
      }
      await wait(200);
    }
    assert.ok(seated && rejected, 'exactly one seats and the other is rejected');
    assert.ok((await statusText(rejected!)).includes('524'), 'rejection reports code 524');

    await wait(500);
    const seatedCircles = await detectCircles(seated!);
    const rejectedCircles = await detectCircles(rejected!);
    assert.equal(seatedCircles.length, 1, 'seated canvas keeps one circle');
    assert.equal(seatedCircles[0].color, 'blue', 'the remaining circle is the seated player’s own (blue)');
    assert.equal(rejectedCircles.length, 0, 'rejected player paints no circle');

    await pageA.close();
    await pageB.close();
  });
});
