const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'https://grocy.audibox.cc';
const LANG = process.argv[2] || 'en';
const OUT = process["env"].GROCY_OUT || '/tmp/grocy-lang-' + LANG;
fs.mkdirSync(OUT, { recursive: true });
const PAGES = [
  ['stockoverview', '/stockoverview'], ['shoppinglist', '/shoppinglist'], ['recipes', '/recipes'], ['mealplan', '/mealplan'],
  ['purchase', '/purchase'], ['consume', '/consume'], ['products', '/products'], ['stocksettings', '/stocksettings'],
  ['usersettings', '/usersettings'], ['choresoverview', '/choresoverview'], ['tasks', '/tasks'],
  ['cuisine', '/userobjects/cuisine#restes'], ['cuisine-favoris', '/userobjects/cuisine#favoris'], ['cuisine-export', '/userobjects/cuisine#export'],
  ['tickets', '/userobjects/tickets#scan'], ['tickets-hist', '/userobjects/tickets#hist'], ['tickets-trend', '/userobjects/tickets#trend']
];
const VIEWPORTS = [[1440, { width: 1440, height: 1100 }], [390, { width: 390, height: 844 }]];

async function settle(page) { try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (e) {} await page.waitForTimeout(1200); await page.evaluate(() => { document.body.classList.remove('night-mode'); document.querySelectorAll('link[href*="grocy_night_mode.css"]').forEach(l => l.remove()); }).catch(() => {}); await page.evaluate(() => document.fonts.ready).catch(() => {}); await page.waitForTimeout(3200); }
function texts(page) {
  return page.evaluate(() => {
    const out = new Set();
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      const el = n.parentElement;
      if (!t || !el || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
      out.add(t);
    }
    document.querySelectorAll('[placeholder],[title],[aria-label],[data-g-label],[data-g-sub]').forEach(e => {
      ['placeholder', 'title', 'aria-label', 'data-g-label', 'data-g-sub'].forEach(a => { const v = e.getAttribute(a); if (v && v.trim()) out.add('@' + a + ': ' + v.trim()); });
    });
    return { lang: document.documentElement.lang, gl: window.GL ? window.GL.lang : null, texts: [...out] };
  });
}

(async () => {
  const browser = await chromium.launch(process["env"].CHROME_BIN ? { executablePath: process["env"].CHROME_BIN } : { channel: 'chromium' });
  const report = {};
  for (const [w, vp] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, ignoreHTTPSErrors: true, locale: LANG === 'fr' ? 'en-US' : 'fr-FR' });
    const page = await ctx.newPage();
    await page.route(/n8n\.audibox\.cc/, r => r.abort());
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.fill('#username', 'miira'); await page.fill('#password_input', process["env"].GROCY_PASSWORD);
    await page.evaluate((pw) => { document.querySelector('#username').value = 'miira'; document.querySelector('#password_input').value = pw; }, process["env"].GROCY_PASSWORD);
    await page.click('#login-button'); await settle(page);
    if (page.url().includes('/login')) throw new Error('login failed');
    const productHref = await page.goto(BASE + '/products').then(() => settle(page)).then(() => page.evaluate(() => { const a = [...document.querySelectorAll('a[href]')].find(a => /\/product\/\d+/.test(a.getAttribute('href'))); return a ? a.getAttribute('href') : null; }));
    const targets = PAGES.slice();
    if (productHref) targets.push(['productform', productHref]);
    for (const [name, path] of targets) {
      await page.goto(path.startsWith('http') ? path : BASE + path); await settle(page);
      if (path.includes('#')) { await page.reload(); await settle(page); }
      await page.screenshot({ path: `${OUT}/lang-${LANG}-${name}-${w}.png` });
      if (w === 1440) report[name] = await texts(page);
      if (name === 'stockoverview' && w === 390) {
        const more = await page.$('.g-tabbar button.g-tab');
        if (more) { await more.click(); await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}/lang-${LANG}-sheet-390.png` }); report.sheet = await texts(page); }
      }
    }
    report['errors-' + w] = errs.slice(0, 20);
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(`${OUT}/texts.json`, JSON.stringify(report, null, 1));
  console.log('done', OUT);
})().catch(e => { console.error(e.message); process.exit(1); });
