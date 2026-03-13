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
        if (result.url.includes("duckduckgo.com")) {
          try {
            const u = new URL(result.url);
            const uddg = u.searchParams.get("uddg");
            if (uddg) {
              result.url = uddg;
            }
          } catch {}
        }
      }
      // Filter out ad results that still point to duckduckgo redirects
      return results.filter((r) => !r.url.includes("duckduckgo.com/y.js"));
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
    usage: "GET /search?q=your+query&limit=5&engine=duckduckgo&llms=true",
    engines: SUPPORTED_ENGINES,
    params: {
      q: "Search query (required)",
      limit: "Number of results 1-20 (default: 5)",
      engine: "Search engine: duckduckgo, bing, yahoo (default: duckduckgo)",
      llms: "Fetch /llms.txt from each result's domain (default: false)",
    },
  });
});

app.get("/search", async (c) => {
  const query = c.req.query("q");
  if (!query) {
    return c.json({ error: "Missing query parameter 'q'" }, 400);
  }

  const limit = Math.min(Math.max(parseInt(c.req.query("limit")) || 5, 1), 20);
  const engineName = (c.req.query("engine") || "duckduckgo").toLowerCase();
  const fetchLlms = c.req.query("llms") === "true" || c.req.query("llms") === "1";
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

    // Resolve redirect URLs and filter out ads if the engine requires it
    if (engine.resolveUrls) {
      const filtered = engine.resolveUrls(searchResults);
      if (filtered) {
        searchResults.length = 0;
        searchResults.push(...filtered);
      }
    }

    if (searchResults.length === 0) {
      await browser.close();
      return c.json({ query, engine: engineName, results: [], message: "No results found" });
    }

    // Fetch page content for each result (sequentially to avoid overwhelming the browser)
    const resultsWithContent = [];
    for (const result of searchResults) {
      // Skip URLs that aren't valid http(s) links
      if (!result.url.startsWith("http")) {
        resultsWithContent.push({ ...result, content: "Failed to fetch page content" });
        continue;
      }
      try {
        const contentPage = await browser.newPage();
        await contentPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );
        await contentPage.goto(result.url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

          const pageData = await contentPage.evaluate(() => {
            // Extract favicon
            let favicon = "";
            const iconLink = document.querySelector(
              'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]'
            );
            if (iconLink) {
              favicon = iconLink.href;
            } else {
              favicon = new URL("/favicon.ico", document.location.origin).href;
            }

            // Try to find main content container first (for JS-heavy sites like Apple docs)
            const mainSelectors = [
              "article",
              "main",
              "[role='main']",
              ".documentation-content",
              ".content",
              "#content",
              ".main-content",
              ".article-content",
              ".post-content",
              "[data-content]",
            ];
            let contentEl = null;
            for (const sel of mainSelectors) {
              const el = document.querySelector(sel);
              if (el && el.innerText.trim().length > 150) {
                contentEl = el;
                break;
              }
            }

            let content = "";
            if (contentEl) {
              content = contentEl.innerText.replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000);
            } else {
              // Fallback: remove boilerplate and use body
              const remove = document.querySelectorAll(
                "script, style, nav, footer, header, iframe, noscript, svg, [role='banner'], [role='navigation'], [role='complementary']"
              );
              remove.forEach((el) => el.remove());
              const body = document.body;
              content = body ? body.innerText.replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000) : "";
            }

            return { content, favicon };
          });

          await contentPage.close();
          resultsWithContent.push({ ...result, favicon: pageData.favicon, content: pageData.content });
        } catch (err) {
          console.error(`Failed to fetch content for ${result.url}: ${err.message}`);
          resultsWithContent.push({ ...result, content: "Failed to fetch page content" });
        }
      }

    // Fetch /llms.txt from each result's domain if llms param is set
    if (fetchLlms) {
      const seenDomains = new Set();
      for (const result of resultsWithContent) {
        try {
          const origin = new URL(result.url).origin;
          if (seenDomains.has(origin)) {
            // Reuse llms_txt from a previous result with the same domain
            const prev = resultsWithContent.find(
              (r) => r.llms_txt && new URL(r.url).origin === origin
            );
            result.llms_txt = prev ? prev.llms_txt : null;
            continue;
          }
          seenDomains.add(origin);
          const llmsPage = await browser.newPage();
          const llmsUrl = `${origin}/llms.txt`;
          const response = await llmsPage.goto(llmsUrl, {
            waitUntil: "domcontentloaded",
            timeout: 10000,
          });
          if (response && response.ok()) {
            const text = await llmsPage.evaluate(() => document.body?.innerText || "");
            result.llms_txt = text.trim().slice(0, 10000) || null;
          } else {
            result.llms_txt = null;
          }
          await llmsPage.close();
        } catch {
          result.llms_txt = null;
        }
      }
    }

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
