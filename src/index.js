const { Hono } = require("hono");
const { serve } = require("@hono/node-server");
const puppeteer = require("puppeteer");

const ENGINES = {
  duckduckgo: {
    searchUrl: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    waitUntil: "domcontentloaded",
    extract: (maxResults) => {
      const results = [];
      const items = document.querySelectorAll(".result");
      for (const item of items) {
        if (results.length >= maxResults) break;
        const anchor = item.querySelector("a.result__a");
        const snippetEl = item.querySelector(".result__snippet");
        if (anchor) {
          const href = anchor.href;
          const title = anchor.textContent.trim();
          if (href && title) {
            results.push({ title, url: href, snippet: snippetEl ? snippetEl.textContent.trim() : "" });
          }
        }
      }
      return results;
    },
    resolveUrls: (results) => {
      for (const result of results) {
        if (result.url.includes("duckduckgo.com/l/")) {
          try {
            const u = new URL(result.url);
            const uddg = u.searchParams.get("uddg");
            if (uddg) result.url = uddg;
          } catch {}
        }
      }
    },
  },
  google: {
    searchUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&udm=14`,
    waitUntil: "networkidle2",
    extract: (maxResults) => {
      const results = [];
      // Try standard selectors first, then fallback patterns
      const items = document.querySelectorAll("div.g, div[data-hveid] div.tF2Cxc");
      for (const item of items) {
        if (results.length >= maxResults) break;
        const anchor = item.querySelector("a[href^='http']");
        const titleEl = item.querySelector("h3");
        const snippetEl = item.querySelector("[data-sncf], .VwiC3b, .IsZvec, span.aCOpRe");
        if (anchor && titleEl) {
          results.push({
            title: titleEl.textContent.trim(),
            url: anchor.href,
            snippet: snippetEl ? snippetEl.textContent.trim() : "",
          });
        }
      }
      return results;
    },
  },
  bing: {
    searchUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    waitUntil: "domcontentloaded",
    extract: (maxResults) => {
      const results = [];
      const items = document.querySelectorAll("li.b_algo");
      for (const item of items) {
        if (results.length >= maxResults) break;
        const anchor = item.querySelector("h2 a");
        const cite = item.querySelector("cite");
        const snippetEl = item.querySelector(".b_caption p, .b_algoSlug");
        if (anchor) {
          results.push({
            title: anchor.textContent.trim(),
            url: anchor.href,
            cite: cite ? cite.textContent.trim() : "",
            snippet: snippetEl ? snippetEl.textContent.trim() : "",
          });
        }
      }
      return results;
    },
    resolveUrls: (results) => {
      for (const result of results) {
        if (result.url.includes("bing.com/ck/a")) {
          try {
            const u = new URL(result.url);
            const encoded = u.searchParams.get("u");
            if (encoded && encoded.startsWith("a1")) {
              result.url = Buffer.from(encoded.slice(2), "base64").toString("utf-8");
            } else if (result.cite) {
              const cite = result.cite;
              result.url = cite.startsWith("http") ? cite : `https://${cite.replace(/ › /g, "/")}`;
            }
          } catch {}
        }
        delete result.cite;
      }
    },
  },
  yahoo: {
    searchUrl: (q) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`,
    waitUntil: "networkidle2",
    extract: (maxResults) => {
      const results = [];
      const items = document.querySelectorAll("#web ol li");
      for (const item of items) {
        if (results.length >= maxResults) break;
        const algo = item.querySelector(".algo");
        if (!algo) continue;
        const anchor = algo.querySelector("a.ac-algo, .compTitle a, h3 a");
        const titleEl = algo.querySelector("h3 span");
        const snippetEl = algo.querySelector(".compText p");
        if (anchor && anchor.href) {
          results.push({
            title: titleEl ? titleEl.textContent.trim() : anchor.textContent.trim(),
            url: anchor.href,
            snippet: snippetEl ? snippetEl.textContent.trim() : "",
          });
        }
      }
      return results;
    },
    resolveUrls: (results) => {
      for (const result of results) {
        if (result.url.includes("r.search.yahoo.com")) {
          try {
            const match = result.url.match(/\/RU=([^/]+)\//);
            if (match) result.url = decodeURIComponent(match[1]);
          } catch {}
        }
      }
    },
  },
};

const SUPPORTED_ENGINES = Object.keys(ENGINES);

const app = new Hono();

app.get("/", (c) => {
  return c.json({
    status: "ok",
    usage: "GET /search?q=your+query&limit=5&engine=duckduckgo",
    engines: SUPPORTED_ENGINES,
  });
});

app.get("/search", async (c) => {
  const query = c.req.query("q");
  if (!query) {
    return c.json({ error: "Missing query parameter 'q'" }, 400);
  }

  const limit = Math.min(Math.max(parseInt(c.req.query("limit")) || 5, 1), 20);
  const engineName = (c.req.query("engine") || "duckduckgo").toLowerCase();
  const engine = ENGINES[engineName];

  if (!engine) {
    return c.json({ error: `Unsupported engine '${engineName}'. Supported: ${SUPPORTED_ENGINES.join(", ")}` }, 400);
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

    await page.goto(engine.searchUrl(query), {
      waitUntil: engine.waitUntil || "domcontentloaded",
      timeout: 15000,
    });

    const searchResults = await page.evaluate(engine.extract, limit);

    // Resolve redirect URLs if the engine requires it
    if (engine.resolveUrls) {
      engine.resolveUrls(searchResults);
    }

    if (searchResults.length === 0) {
      await browser.close();
      return c.json({ query, engine: engineName, results: [], message: "No results found" });
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
    return c.json({ query, engine: engineName, results: resultsWithContent });
  } catch (err) {
    if (browser) await browser.close();
    return c.json({ error: "Search failed", details: err.message }, 500);
  }
});

const port = process.env.PORT || 3000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`Search API running on http://localhost:${port}`);
});
