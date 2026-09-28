const { chromium } = require('playwright');
const fs = require('fs');
const { execFileSync } = require('child_process');
const BASE = (process["env"].GROCY_SHOT_BASE || process["env"].GROCY_BASE || 'https://grocy.audibox.cc').replace(/\/+$/, '');
const TEST_HOST = 'grocy-test.audibox.cc';
const KEYS_CONF = '/home/miira/apps/docker/n8n-templates/keys.conf';
const IS_TEST = new URL(BASE).hostname === TEST_HOST;
const TAG = process.argv[2] || 'v2';
const OUT = '/tmp/grocy-' + TAG;
fs.mkdirSync(OUT, { recursive: true });
const PAGES = (process.argv[3] ? process.argv[3].split(',') : ['stockoverview', 'shoppinglist', 'recipes', 'purchase', 'products', 'stocksettings', 'mealplan', 'consume', 'userobjects/cuisine', 'userobjects/tickets']);
const VIEWPORTS = [[1440, { width: 1440, height: 1100 }], [390, { width: 390, height: 844 }]];
const log = [];

function testPassword() {
  if (!IS_TEST) throw new Error('refusing the grocy-test password outside ' + TEST_HOST);
  const script = `sed -n 's/^GROCY_TEST_PASSWORD=//p' ${KEYS_CONF}`;
  const out = fs.existsSync(KEYS_CONF)
    ? execFileSync('sh', ['-c', script], { encoding: 'utf8' })
    : execFileSync('ssh', ['audibox', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (!out.trim()) throw new Error('GROCY_TEST_PASSWORD missing from keys.conf');
  return out.trim();
}
function password() {
  if (IS_TEST) return testPassword();
  if (!process["env"].GROCY_PASSWORD) throw new Error('GROCY_PASSWORD not set (keys.conf is only read for ' + TEST_HOST + ')');
  return process["env"].GROCY_PASSWORD;
}
async function login(page) {
  const pw = password();
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.evaluate(([u, p]) => { document.querySelector('#username').value = u; document.querySelector('#password_input').value = p; }, ['miira', pw]);
  await page.click('#login-button');
  await page.waitForLoadState('networkidle');
}
async function settle(page) { try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (e) {} await page.waitForTimeout(900); }
async function setDark(page) {
  await page.evaluate(() => {
    document.body.classList.add('night-mode');
    if (!document.querySelector('link[href*="grocy_night_mode.css"]')) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/css/grocy_night_mode.css'; l.id = 'night-mode-stylesheet';
      document.head.appendChild(l);
    }
  });
  await page.waitForTimeout(700);
}
async function shoot(page, name, w, theme) {
  await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png`, fullPage: false });
}
async function consoleErrors(page, sink) {
  page.on('pageerror', e => sink.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') sink.push('console: ' + m.text()); });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process["env"].CHROME_BIN || undefined });
  for (const [w, vp] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.route(/n8n\.audibox\.cc/, r => r.abort());
    const errs = [];
    await consoleErrors(page, errs);
    await page.goto(BASE + '/login'); await settle(page);
    await shoot(page, 'login', w, 'light');
    await setDark(page); await shoot(page, 'login', w, 'dark');
    await login(page);
    let productHref = null;
    await page.goto(BASE + '/products'); await settle(page);
    productHref = await page.evaluate(() => { const a = [...document.querySelectorAll('a[href]')].find(a => /\/product\/\d+/.test(a.getAttribute('href'))); return a ? a.getAttribute('href') : null; });
    const targets = PAGES.map(p => [p.replace(/\//g, '-'), '/' + p]);
    if (productHref) targets.push(['productform', productHref]);
    for (const [name, path] of targets) {
      try {
        const url = path.startsWith('http') ? path : BASE + (path.startsWith('/') ? path : '/' + path);
        await page.goto(url); await settle(page);
        await shoot(page, name, w, 'light');
        await setDark(page);
        await shoot(page, name, w, 'dark');
        if (name === 'stockoverview') {
          if (w === 1440) {
            const m = await page.evaluate(() => {
              const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
              return { nav: r('#mainNav'), wrapper: r('.content-wrapper'), hd: r('.g-hd'), tiles: r('.g-tiles'), table: r('#stock-overview-table_wrapper'), sections: document.querySelectorAll('#mainNav .g-section').length, tilesCount: document.querySelectorAll('.g-tile').length, tabbar: !!document.querySelector('.g-tabbar'), theme: !!document.querySelector('#mainNav .g-theme') };
            });
            fs.writeFileSync(`${OUT}/stockoverview-metrics.json`, JSON.stringify(m, null, 2));
            await page.click('#sidenavToggler'); await page.waitForTimeout(500);
            await shoot(page, 'stockoverview-rail', w, 'dark');
            await page.click('#sidenavToggler'); await page.waitForTimeout(300);
            await page.click('#mainNav .navbar-nav.ml-auto > .nav-item.dropdown:last-child > .nav-link'); await page.waitForTimeout(400);
            await shoot(page, 'stockoverview-menu', w, 'dark');
          } else {
            const more = await page.$('.g-tabbar button.g-tab');
            if (more) { await more.click(); await page.waitForTimeout(400); await shoot(page, 'stockoverview-sheet', w, 'dark'); }
          }
        }
        log.push({ name, w, ok: true });
      } catch (e) { log.push({ name, w, ok: false, err: e.message }); }
    }
    log.push({ w, errors: errs.slice(0, 20) });
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(`${OUT}/run-log.json`, JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log));
})().catch(e => { console.error(e.message); process.exit(1); });
