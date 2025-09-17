/* eslint-disable no-console */
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 3000;
const HEADLESS = process.env.HEADLESS ?? 'new';   // 'new' consigliato da Puppeteer 22
const PROXY = process.env.PROXY_URL || null;      // opzionale: es. http://user:pass@host:port

// ---- util ----
async function launchBrowser() {
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (PROXY) args.push(`--proxy-server=${PROXY}`);
  return puppeteer.launch({
    headless: HEADLESS,
    args,
    defaultViewport: { width: 1366, height: 900 }
  });
}

async function clickConsent(page) {
  try {
    await page.waitForTimeout(400);
    // prova pulsanti tipici cookie/consenso
    const btn = await page.$x(
      "//button[contains(., 'Accetta') or contains(., 'Accetto') or contains(., 'Accept') or contains(., 'Consenti')]"
    );
    if (btn[0]) await btn[0].click();
  } catch {}
}

function slugify(s) {
  return s.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, '_');
}

async function gotoResults(page, { q, city = 'milano', region = 'lombardia' }) {
  const slug = slugify(q);
  const candidates = [
    `https://www.paginegialle.it/ricerca/${encodeURIComponent(q)}/${encodeURIComponent(city)}`,
    `https://www.paginegialle.it/${region}/${city}/${slug}.html`,
    `https://www.paginegialle.it/ricerca/${encodeURIComponent(q)}`
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      await clickConsent(page);
      const ok = await page.$('h1, [class*=risultat], [id*=risultat]');
      if (ok) return { ok: true, urlTried: url };
    } catch {}
  }
  // fallback: homepage con form
  try {
    await page.goto('https://www.paginegialle.it', { waitUntil: 'networkidle2', timeout: 45000 });
    await clickConsent(page);
    const [what] = await page.$x("//input[@placeholder=\"Inserisci il nome dell’attività\" or @placeholder=\"Inserisci il nome dell'attività\"] | //input[contains(@aria-label,'attività')]");
    const [where] = await page.$x("//input[@placeholder=\"Inserisci l'indirizzo\"] | //input[contains(@aria-label,'indirizzo') or contains(@aria-label,'dove')]");
    if (what) { await what.click(); await what.type(q); }
    if (where) { await where.click(); await where.type(city); }
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 });
    return { ok: true, urlTried: 'form' };
  } catch {}
  return { ok: false };
}

async function extractSynonyms(page) {
  return page.evaluate(() => {
    const bag = new Set();

    function collectFromBox(box) {
      if (!box) return;
      box.querySelectorAll('a, button, span, li').forEach(el => {
        const t = (el.innerText || '').trim();
        if (
          t && t.length < 60 &&
          !/prenota|aperto|chiuso|ordina|distanza|filtri|mappa|recensioni/i.test(t)
        ) bag.add(t);
      });
    }

    // 1) box filtri dichiarati
    document.querySelectorAll('[class*=filter], [class*=filtri], [id*=filter]').forEach(collectFromBox);

    // 2) heading “Tipi di … / Categorie correlate / Specialità”
    document.querySelectorAll('h2,h3,h4,strong,[role=heading]').forEach(h => {
      const tx = (h.textContent || '').toLowerCase();
      if (/tipi di|categorie correlate|categorie simili|specialit|prodotti|settori/.test(tx)) {
        collectFromBox(h.closest('section,div,aside') || h.parentElement);
      }
    });

    // 3) fallback testuale vicino a “Tipi di”
    if (!bag.size) {
      const body = document.body.innerText || '';
      const m = body.match(/Tipi di[^\n]*\n([\s\S]{0,600})/i);
      if (m) m[1].split(/\s{2,}|\n/).map(s => s.trim()).filter(Boolean).forEach(v => bag.add(v));
    }

    return Array.from(bag);
  });
}

async function extractCount(page) {
  const text = (await page.$eval('body', el => el.innerText)).toLowerCase();
  const m1 = text.match(/([\d\.\s]+)\s+risultat/i);
  if (m1) {
    const n = parseInt(m1[1].replace(/\./g, '').trim(), 10);
    if (!Number.isNaN(n)) return n;
  }
  const m2 = text.match(/pi[uù]\s+di\s+(\d+)/i);
  if (m2) return `${m2[1]}+`;
  if (/nessun risultato|0 risultati/.test(text)) return 0;
  return null;
}

// ---- API ----
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

// Trova sinonimi/sottocategorie (filtri) per una categoria
app.post('/synonyms', async (req, res) => {
  const { category, city = 'milano', region = 'lombardia', limit = 25 } = req.body || {};
  if (!category) return res.status(400).json({ error: 'category is required' });

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(45000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');

    const nav = await gotoResults(page, { q: category, city, region });
    if (!nav.ok) throw new Error('cannot reach results page');

    await page.waitForTimeout(800);
    let synonyms = await extractSynonyms(page);
    synonyms = Array.from(new Set(
      synonyms.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s && s.length <= 60)
    )).slice(0, limit);

    res.json({ category, city, region, count: synonyms.length, synonyms });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await browser.close().catch(() => {});
  }
});

// Conta risultati per un termine (es. un sinonimo)
app.post('/count', async (req, res) => {
  const { term, city = 'milano', region = 'lombardia' } = req.body || {};
  if (!term) return res.status(400).json({ error: 'term is required' });

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(45000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');

    const nav = await gotoResults(page, { q: term, city, region });
    if (!nav.ok) throw new Error('cannot reach results page');

    await page.waitForTimeout(500);
    const count = await extractCount(page);
    res.json({ term, city, region, results: count ?? 'unknown' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await browser.close().catch(() => {});
  }
});

// Flusso completo: categoria -> sinonimi -> (opzionale) conteggi
app.post('/scrape', async (req, res) => {
  const { category, city = 'milano', region = 'lombardia', withCounts = true, limit = 25 } = req.body || {};
  if (!category) return res.status(400).json({ error: 'category is required' });

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(45000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');

    const nav = await gotoResults(page, { q: category, city, region });
    if (!nav.ok) throw new Error('cannot reach results page');

    await page.waitForTimeout(800);
    let synonyms = await extractSynonyms(page);
    synonyms = Array.from(new Set(
      synonyms.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s && s.length <= 60)
    )).slice(0, limit);

    if (!withCounts) {
      return res.json({ category, city, region, items: synonyms.map(s => ({ synonym: s })) });
    }

    const items = [];
    for (const s of synonyms) {
      const nav2 = await gotoResults(page, { q: `${s} ${city}`, city, region });
      if (!nav2.ok) { items.push({ synonym: s, results: 'unknown' }); continue; }
      await page.waitForTimeout(400);
      const n = await extractCount(page);
      items.push({ synonym: s, results: n ?? 'unknown' });
    }

    res.json({ category, city, region, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await browser.close().catch(() => {});
  }
});

// Modalità CLI per nodo n8n "Execute Command"
async function runCli() {
  const [, , flag, categoryArg, cityArg = 'milano', regionArg = 'lombardia'] = process.argv;
  if (flag !== '--cli') return;
  if (!categoryArg) {
    console.error('Usage: node server.js --cli "<categoria>" [citta] [regione]');
    process.exit(1);
  }
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const nav = await gotoResults(page, { q: categoryArg, city: cityArg, region: regionArg });
    if (!nav.ok) throw new Error('cannot reach results page');
    await page.waitForTimeout(800);
    let synonyms = await extractSynonyms(page);
    synonyms = Array.from(new Set(synonyms.map(s => s.replace(/\s+/g, ' ').trim()))).slice(0, 25);

    const out = [];
    for (const s of synonyms) {
      const nav2 = await gotoResults(page, { q: `${s} ${cityArg}`, city: cityArg, region: regionArg });
      await page.waitForTimeout(300);
      out.push({ category: categoryArg, synonym: s, results: await extractCount(page) });
    }
    console.log(JSON.stringify(out));
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(2);
  } finally {
    await launchBrowser().then(b => b.close()).catch(()=>{});
    process.exit(0);
  }
}
if (process.argv[2] === '--cli') runCli();
else express().listen; // noop per lincea
app.listen(PORT, () => console.log(`Scraper API listening on :${PORT}`));
