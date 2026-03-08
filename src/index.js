const { Hono } = require("hono");
const { serve } = require("@hono/node-server");
const puppeteer = require("puppeteer");

const app = new Hono();

app.get("/", (c) => {
  return c.json({ status: "ok", usage: "GET /search?q=your+query" });
});

app.get("/search", async (c) => {
  const query = c.req.query("q");
  if (!query) {
    return c.json({ error: "Missing query parameter 'q'" }, 400);
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Use DuckDuckGo HTML version (no JS required, no CAPTCHAs)
    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 15000 }
    );

    // Extract top 5 search result links and snippets
    const searchResults = await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll(".result");
      for (const item of items) {
        if (results.length >= 5) break;
        const anchor = item.querySelector("a.result__a");
        const snippetEl = item.querySelector(".result__snippet");
        if (anchor) {
          const href = anchor.href;
          const title = anchor.textContent.trim();
          if (href && title) {
            results.push({
              title,
              url: href,
              snippet: snippetEl ? snippetEl.textContent.trim() : "",
            });
          }
        }
      }
      return results;
    });

    // Resolve DuckDuckGo redirect URLs
    for (const result of searchResults) {
      if (result.url.includes("duckduckgo.com/l/")) {
        try {
          const u = new URL(result.url);
          const uddg = u.searchParams.get("uddg");
          if (uddg) result.url = uddg;
        } catch {}
      }
    }

    if (searchResults.length === 0) {
      await browser.close();
      return c.json({ query, results: [], message: "No results found" });
    }

    // Fetch page content for each result
    const resultsWithContent = await Promise.all(
      searchResults.map(async (result) => {
        try {
          const contentPage = await browser.newPage();
          await contentPage.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          );
          await contentPage.goto(result.url, {
            waitUntil: "domcontentloaded",
            timeout: 10000,
          });

          const content = await contentPage.evaluate(() => {
            const remove = document.querySelectorAll(
              "script, style, nav, footer, header, iframe, noscript, svg, [role='banner'], [role='navigation'], [role='complementary']"
            );
            remove.forEach((el) => el.remove());

            const body = document.body;
            if (!body) return "";
            return body.innerText
              .replace(/\n{3,}/g, "\n\n")
              .trim()
              .slice(0, 5000);
          });

          await contentPage.close();
          return { ...result, content };
        } catch {
          return { ...result, content: "Failed to fetch page content" };
        }
      })
    );

    await browser.close();
    return c.json({ query, results: resultsWithContent });
  } catch (err) {
    if (browser) await browser.close();
    return c.json({ error: "Search failed", details: err.message }, 500);
  }
});

const port = process.env.PORT || 3000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`Search API running on http://localhost:${port}`);
});
