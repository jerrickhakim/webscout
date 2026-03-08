# WebScout

A lightweight search API that performs web searches via Puppeteer, fetches the top results, and returns their page content. Built with [Hono](https://hono.dev) and ready to deploy to [Fly.io](https://fly.io).

> This project was generated and tested by AI (Claude).

## How It Works

1. Receives a search query via `GET /search?q=your+query&limit=5`
2. Launches a headless browser with Puppeteer
3. Searches DuckDuckGo and extracts the top results (configurable via `limit`, default 5, max 20)
4. Visits each result page and extracts the text content (up to 5000 characters)
5. Returns everything as structured JSON

## API

### `GET /`

Health check. Returns status and usage info.

### `GET /search?q=your+query&limit=5`

Returns search results with page content.

**Parameters:**

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `q`       | Yes      | —       | Search query |
| `limit`   | No       | 5       | Number of results to return (1–20) |

**Response:**

```json
{
  "query": "your query",
  "results": [
    {
      "title": "Page Title",
      "url": "https://example.com",
      "snippet": "Short description from search results...",
      "content": "Extracted text content from the page..."
    }
  ]
}
```

## Run Locally

```bash
npm install
npm run dev
```

The server starts at `http://localhost:3000`.

## Run with Docker

```bash
docker build -t webscout .
docker run -p 3000:3000 webscout
```

## Deploy to Fly.io

```bash
fly auth login
fly launch
fly deploy
```

## Tech Stack

- **Hono** - Web framework
- **Puppeteer** - Headless browser for scraping
- **Node.js 20** - Runtime
- **Docker** - Containerization
- **Fly.io** - Deployment target
