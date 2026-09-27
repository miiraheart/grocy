const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'https://grocy.audibox.cc';
const OUT = '/tmp/grocy-dialogs';
fs.mkdirSync(OUT, { recursive: true });
const log = [];
async function settle(page, ms) { try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (e) {} await page.waitForTimeout(ms || 800); }
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.fill('#username', 'miira'); await page.fill('#password_input', process["env"].GROCY_PASSWORD); await page.click('#login-button'); await settle(page);
  await page.goto(BASE + '/stockoverview'); await settle(page, 1200);
  log.push({ counts: await page.evaluate(() => [...document.querySelectorAll('#mainNav .g-count')].map(e => e.parentElement.textContent.trim().replace(/\s+/g, ' '))) });
  // dark for the dialog shots
  await page.evaluate(() => { document.body.classList.add('night-mode'); if (!document.querySelector('link[href*="grocy_night_mode.css"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/css/grocy_night_mode.css'; l.id = 'night-mode-stylesheet'; document.head.appendChild(l); } });
  await page.waitForTimeout(600);
  // 1. reports dropdown in header
  await page.click('.g-hd-r .dropdown-toggle'); await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/header-dropdown.png' });
  await page.keyboard.press('Escape'); await page.click('body', { position: { x: 700, y: 900 } }); await page.waitForTimeout(300);
  // 2. row inline menu (only opens a menu)
  await page.click('#stock-overview-table tbody tr:first-child .btn-light[data-toggle="dropdown"]'); await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/row-menu.png' });
  await page.keyboard.press('Escape'); await page.click('body', { position: { x: 700, y: 900 } }); await page.waitForTimeout(300);
  // 3. product card modal (read only)
  await page.click('#stock-overview-table tbody tr:first-child td.productcard-trigger'); await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/productcard-modal.png' });
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  // 4. embedded dialog: stock entries of the first product (GET iframe)
  await page.click('#stock-overview-table tbody tr:first-child .btn-light[data-toggle="dropdown"]'); await page.waitForTimeout(400);
  const link = await page.$('#stock-overview-table tbody tr:first-child .table-inline-menu a[href*="stockentries?embedded"]');
  if (link) { await link.click(); await page.waitForTimeout(2500); await page.screenshot({ path: OUT + '/embedded-stockentries.png' }); await page.keyboard.press('Escape'); await page.waitForTimeout(500); }
  // 5. theme toggle round trip: read, toggle, verify, restore
  const before = await page.evaluate(() => ({ setting: Grocy.UserSettings.night_mode, dark: document.body.classList.contains('night-mode') }));
  await page.evaluate(() => { document.body.classList.remove('night-mode'); });
  await page.click('#mainNav .g-theme'); await page.waitForTimeout(1200);
  const mid = await page.evaluate(() => ({ setting: Grocy.UserSettings.night_mode, dark: document.body.classList.contains('night-mode'), label: document.querySelector('#mainNav .g-theme-label').textContent }));
  await page.screenshot({ path: OUT + '/after-toggle.png' });
  await page.evaluate((orig) => { const r = document.querySelector('input[name=night-mode][value="' + orig + '"]'); if (r) { r.checked = true; $(r).trigger('change'); } }, before.setting);
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({ setting: Grocy.UserSettings.night_mode, dark: document.body.classList.contains('night-mode') }));
  log.push({ theme: { before, mid, after } });
  // 6. status tile click filters (read only) then clear
  await page.click('#info-duesoon-products'); await page.waitForTimeout(800);
  log.push({ tileFilter: await page.evaluate(() => ({ status: document.querySelector('#status-filter').value, active: document.querySelectorAll('.g-tile.g-active').length, visibleRows: [...document.querySelectorAll('#stock-overview-table tbody tr')].filter(r => r.offsetParent !== null).length })) });
  await page.screenshot({ path: OUT + '/tile-filter.png' });
  await page.click('#clear-filter-button'); await page.waitForTimeout(500);
  // 7. rowGroup by location via the columns dialog is a user setting write: skip. Sort by clicking a header (client side only)
  await page.click('.dataTables_scrollHead th:nth-child(2)'); await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/sorted.png' });
  log.push({ errors: errs });
  await browser.close();
  fs.writeFileSync(OUT + '/log.json', JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log));
})().catch(e => { console.error(e.message); process.exit(1); });
