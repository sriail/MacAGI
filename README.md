# MacAGI

AI chat application with web search powered by a local [SearXNG](https://docs.searxng.org/) instance.

## Prerequisites

- **Node.js** ≥ 18
- **Docker** & **Docker Compose** (for the SearXNG search engine)

## Quick Start

1. **Clone the repository**

   ```bash
   git clone https://github.com/sriail/MacAGI.git
   cd MacAGI
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment**

   Copy `.env` and set your Cerebras API key:

   ```bash
   echo "CEREBRAS_API_KEY=your_key_here" > .env
   ```

4. **Start SearXNG** (local search engine)

   ```bash
   docker compose up -d
   ```

   SearXNG will be available at `http://localhost:8888`. The configuration in `searxng/settings.yml` disables rate limiting and enables JSON API output so the Node.js server can query it freely.

5. **Start the application**

   ```bash
   npm start
   ```

   Open `http://localhost:3000` in your browser.

## Architecture

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   Browser    │──────▶│  server.js   │──────▶│   SearXNG    │
│  (index.html)│  HTTP │  (Express)   │  HTTP │  (Docker)    │
│              │◀──────│  port 3000   │◀──────│  port 8888   │
└──────────────┘       └──────┬───────┘       └──────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │  Cerebras AI │
                       │     API      │
                       └──────────────┘
```

- **SearXNG** runs as a local Docker container (no external API keys needed, no rate limits).
- **server.js** queries SearXNG for web results, injects them as context into LLM prompts, and returns the AI response with source citations.
- The **frontend** displays source citations in a collapsible box alongside AI responses.

## API Endpoints

| Endpoint             | Method | Description                        |
| -------------------- | ------ | ---------------------------------- |
| `/ping`              | GET    | Health check                       |
| `/api/search-health` | GET    | Check SearXNG connectivity         |
| `/api/chat`          | POST   | Send a chat message with optional search |

## Environment Variables

| Variable           | Default                  | Description             |
| ------------------ | ------------------------ | ----------------------- |
| `CEREBRAS_API_KEY` | —                        | Cerebras AI API key     |
| `SEARXNG_URL`      | `http://localhost:8888`  | SearXNG instance URL    |
| `PORT`             | `3000`                   | Server listen port      |

## SearXNG Configuration

Configuration files are in the `searxng/` directory:

- **`settings.yml`** — Main SearXNG config (enables JSON format, disables safe search, sets port 8888)
- **`limiter.toml`** — Disables bot detection and rate limiting for local use
