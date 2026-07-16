<div align="center">

<img src="frontend/public/favicon.svg" width="84" alt="Vivid AI" />

<h1>image2api</h1>

> **Go2Api fork operations:** read [docs/GO2API_FORK.md](docs/GO2API_FORK.md) before production updates or upstream merges.

**Multi-provider AI image / video generation gateway — one OpenAI-compatible API, seven platforms aggregated, a ready-to-run operations system**

<sub>Live instance (brand): [Vivid AI · vividai.run](https://vividai.run)</sub>

[简体中文](README.md) | **English**

[![Online Demo](https://img.shields.io/badge/Live%20Demo-vividai.run-7c3aed?style=for-the-badge)](https://vividai.run)

[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?logo=vuedotjs&logoColor=white)](https://vuejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](#-deployment)
[![OpenAI Compatible](https://img.shields.io/badge/OpenAI-compatible-412991?logo=openai&logoColor=white)](#-openai-compatible-api)
[![HTTPS](https://img.shields.io/badge/HTTPS-your--proxy-lightgrey)](#-deployment)
[![Providers](https://img.shields.io/badge/providers-7-orange)](#-supported-models--providers)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-success)](#-deployment)
[![License](https://img.shields.io/badge/license-MIT-blue)](#-license)

[Live Demo](https://vividai.run) · [Features](#-features) · [Deploy](#-deployment) · [API](#-openai-compatible-api) · [Community](#-community--contact)

<br/>

<img src="docs/screenshots/playground.png" alt="image2api — playground" width="860" />

</div>

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Screenshots](#-screenshots)
- [Features](#-features)
- [Supported Models / Providers](#-supported-models--providers)
- [OpenAI-Compatible API](#-openai-compatible-api)
- [Deployment](#-deployment)
- [Tech Stack](#-tech-stack)
- [Repository Layout](#-repository-layout)
- [Roadmap](#-roadmap)
- [Community / Contact](#-community--contact)
- [License](#-license)

## ✨ Overview

**image2api** wraps the image / video capabilities of Adobe Firefly, OpenAI, Runway, Grok, Leonardo, Krea and Imagine into **a single OpenAI-compatible API**. Behind it, multi-account pools are scheduled automatically — out of quota → switch account, auth expired → refresh or kill, transient errors → retry, tokens proactively renewed before they expire — to deliver a stable service.

It's more than an API proxy: it ships with **credit billing, CDK top-ups, referral rewards, a user system, an admin console, and a modern generation frontend**, so a single command turns it into a fully operational AI generation site — the author's live instance **[Vivid AI · vividai.run](https://vividai.run)** (brand) is built on this project.

> 💡 Both frontend and backend are **fully open-source** (MIT) — Go + Vue 3, free to fork and self-host.

**At a glance** 🔌 OpenAI-compatible · 🤖 7 platforms, 10+ models · 🔁 auto failover / token keep-alive · 💳 credits + agent pricing · 🎨 generation frontend + admin console · 🐳 one-command deploy (bring your own TLS proxy)

## 🖼️ Screenshots

<div align="center">
<sub>🎨 Modern generation frontend · light / dark admin console · data-driven ops dashboard</sub>
</div>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/dashboard.png" alt="Dashboard" /></td>
    <td width="50%"><img src="docs/screenshots/models.png" alt="Models" /></td>
  </tr>
  <tr>
    <td align="center"><b>📊 Dashboard</b><br/><sub>Users / volume / provider health / 24h trend</sub></td>
    <td align="center"><b>🧩 Model management</b><br/><sub>Per-model capabilities, pricing & weight</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/accounts.png" alt="Accounts" /></td>
    <td width="50%"><img src="docs/screenshots/logs.png" alt="Logs" /></td>
  </tr>
  <tr>
    <td align="center"><b>🔑 Account pools</b><br/><sub>Multi-account pools · weight / concurrency · CRUD</sub></td>
    <td align="center"><b>📜 Call logs</b><br/><sub>Success / failure / in-progress · prompts & latency</sub></td>
  </tr>
</table>

## 🚀 Features

#### 🎨 Generation
- Images + videos in one place, with **image-to-image / reference frames** (first frame, last frame, style reference)
- Multiple resolutions (images 1K / 2K / 4K · videos 720p / 1080p), aspect ratios and video durations — configured and priced per model
- 7 providers, 10+ models, **enable / disable / re-price from the admin console**, no code changes
- **Model aliases**: one model can expose multiple public ids — API calls with any alias resolve to it
- **De-AI fingerprint** (optional): one-click toggle on the playground — generated images get anti-AI-detection post-processing (subtle detail jitter + metadata stripping), charged as a per-tier surcharge (defaults 1K+1 / 2K+2 / 4K+3 credits, admin-configurable, can be disabled globally); processed works carry a "de-AI" badge across the playground, gallery, logs and admin image manager

#### 🔌 OpenAI Compatible
- Text-to-image `/v1/images/generations` · image-to-image `/v1/images/edits` (multipart ref upload) · video `/v1/videos` (Sora-style async: create → poll → `/content`) · `/v1/models`
- **Strict OpenAI params**: `size` drives **both aspect ratio + resolution tier** (images by long edge → 1K/2K/4K, videos by short edge → 720p/1080p) — just swap `base_url` + `api_key` into an existing OpenAI SDK
- Image results returned **inline as base64** — nothing stored server-side, privacy-friendly; the in-app **/docs** ships a size ↔ tier reference table

#### 🔁 Account Pools + Smart Failover
- Round-robin scheduling across the pool; one bad account doesn't break the whole
- **Out of quota → switch** · **auth expired → refresh & retry / kill** · **transient → retry same account ×3** · **bad params → fail fast**
- **Pre-deducted credits**: atomic debit before generation, auto-refunded on failure, no over-spend under concurrency

#### 🔐 Automatic Token Keep-alive
- Single-use rotating tokens (Krea / Imagine) are **renewed proactively 10 minutes before expiry**; new tokens persisted automatically
- Adobe cookies exchanged for fresh tokens on a schedule; bare JWTs killed on expiry
- Daily quota recovered at each provider's reset time, then re-probed for the real balance

#### 💳 Billing & Operations
- Credit-based (**pre-deduct + refund on failure**), priced per model / resolution / duration; de-AI fingerprint adds a per-tier surcharge
- **Agent pricing**: a user can be set as an "agent" role and models can carry agent prices; agent users (including their API key calls) are billed at the agent price, falling back to the normal price when unset
- **Online top-up (易支付 / epay)**: WeChat / Alipay QR, preset + custom amounts, unpaid orders auto-cancel after 30 min, MD5-verified idempotent callback auto-credits; cumulative top-up tracked
- **CDK redeem codes** · **referral rewards** · email sign-up / verification code / password reset
- **Concurrency groups**: cap a user's simultaneous generations (playground + API key combined, `0` = unlimited), self-healing Redis counters, new users auto-join the default group
- Three roles: regular user / agent / admin (single)

#### 🖥️ User Frontend (Vue 3)
- Playground · creations gallery · generation logs (with failure reasons / source tags)
- Gallery **multi-select batch ops**: select page / bulk delete (videos take their frame stills along) / bulk download (multiple files auto-packed into a zip, fetched concurrently)
- Lightbox preview with built-in **copy original / download / close** buttons; one-click copy of the original image from cards
- **Top-up · Orders** (recharge history / resume unpaid) · API docs · API key management · referral · about, light / dark theme
- **In-app announcements**: a Markdown notice pops up after login and re-shows whenever its content changes

#### 🛠️ Admin Console
- Overview dashboard (trends / DAU / top failures / top spenders)
- Model management (normal + agent price + aliases) · account management (bulk import / dedup / quota) · **concurrency groups** · **order management** (filter / search / paginate) · site-wide logs · user management (set as agent / assign concurrency group / view cumulative top-up / banned-word hits) · CDK · image management (multi-select bulk delete / zip download) · showcase · **announcements** · site config (incl. epay, de-AI fingerprint toggle & surcharge pricing)
- **Banned words**: add / remove words in the console (paginated + multi-select bulk delete); prompts containing a banned word are rejected outright (playground + API, case-insensitive), with per-word / per-user hit counters

**🧰 Engineering highlights**: tls-client (Chrome JA3/JA4 fingerprint) reliably passes Cloudflare · media stored in S3/RustFS, served through an authenticated proxy with retention cleanup · self-healing maintenance loop (quota recovery / credential refresh / orphan-job cleanup with refunds) · one-command Docker deploy (TLS via your own reverse proxy).

## 🤖 Supported Models / Providers

| Provider | Models (examples) | Type |
|---|---|---|
| **Adobe Firefly** | firefly-image-5 · firefly-gpt-image-2 · flux-kontext-max · firefly-video · firefly-ray · gemini-veo31 | Image / Video |
| **OpenAI** | gpt-image-2 | Image |
| **Runway** | runway-gen4-turbo · nano-banana-2 (Nano Banana 2) | Video / Image |
| **Grok (grok.com)** | grok-video (imagine text/image-to-video) | Video |
| **Leonardo.ai** | seedream-4.5 | Image |
| **Krea.ai** | flux-klein-2 | Image |
| **Imagine.art** | imagine-1.5 · imagine-1.5pro | Image |

> Models are enabled and priced dynamically from the admin console — add or remove anytime.

## 🔌 OpenAI-Compatible API

```bash
# Text-to-image — pure OpenAI params: size drives both aspect ratio + tier (long edge <1800→1K / <3500→2K / ≥3500→4K)
curl https://your-domain/v1/images/generations \
  -H "Authorization: Bearer sk-xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a cute cat on a desk, studio lighting",
    "size": "2048x2048"
  }'

# Image-to-image — multipart reference upload (multiple via image[])
curl https://your-domain/v1/images/edits \
  -H "Authorization: Bearer sk-xxxx" \
  -F model="seedream-4.5" -F prompt="make it cyberpunk" -F image=@input.png
```

Images return OpenAI-style `{ "created": ..., "data": [{ "b64_json": "..." }] }` (raw base64, no `data:` prefix, nothing stored server-side). **Video** is async: `POST /v1/videos` → poll `GET /v1/videos/{id}` until `completed` → `GET /v1/videos/{id}/content` for the mp4. Full parameters are documented on the in-app **/docs** page.

## 🚀 Deployment

> Domain + HTTPS are handled by your own reverse proxy (this project issues no certificates).

**Docker (recommended)**: `docker compose up -d --build` brings up PostgreSQL + Redis + RustFS + backend + frontend (nginx serving **HTTP on container port 2000**); point your reverse proxy at `http://<host>:2000` (port via `WEB_PORT`; edit the values (passwords / keys / `CORS_ORIGINS`, and `COOKIE_SECURE=true` when your proxy serves HTTPS) directly in `docker-compose.yml`).

Or **build from source** — bring your own **PostgreSQL · Redis · RustFS (or any S3) · reverse proxy**:

```bash
# 1. Create an empty database (the backend auto-migrates on start)
createdb vivid_ai

# 2. Configure and build the backend from source
cat > backend/.env <<'EOF'
APP_ENV=production
HTTP_ADDR=127.0.0.1:6666
POSTGRES_DSN=host=127.0.0.1 user=postgres password=YOUR_PASSWORD dbname=vivid_ai port=5432 sslmode=disable TimeZone=Asia/Shanghai
REDIS_ADDR=127.0.0.1:6379
RUSTFS_ENDPOINT=http://127.0.0.1:9000
RUSTFS_BUCKET=vivid-ai
RUSTFS_ACCESS_KEY=YOUR_AK
RUSTFS_SECRET_KEY=YOUR_SK
CORS_ORIGINS=https://your-domain
COOKIE_SECURE=true
EOF
cd backend && go build -o bin/api ./cmd/api && ./bin/api   # listens on 127.0.0.1:6666

# 3. Build the frontend (output in frontend/dist)
cd frontend && npm install && npm run build
```

Nginx reverse proxy (issue the certificate yourself with certbot / acme.sh):

```nginx
server {
    listen 443 ssl;
    server_name your-domain;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;
    root /path/to/frontend/dist;
    index index.html;
    client_max_body_size 50m;
    proxy_read_timeout 600s;            # video generation can take a while

    location /assets/ { expires 1y; add_header Cache-Control "public, max-age=31536000, immutable"; }
    location / { try_files $uri $uri/ /index.html; add_header Cache-Control "no-cache"; }
    location ^~ /admin/api/ { proxy_pass http://127.0.0.1:6666; }
    location ^~ /images/    { proxy_pass http://127.0.0.1:6666; }
    location = /health      { proxy_pass http://127.0.0.1:6666; }
    location ^~ /v1/        { proxy_pass http://127.0.0.1:6666; add_header Cache-Control "no-store" always; }
}
```

> See `backend/.env.example` for the full set of environment variables.

</details>

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| Backend | Go · gin · gorm (PostgreSQL) · go-redis · tls-client (Chrome fingerprint) |
| Frontend | Vue 3 · Vue Router · Vite · Tailwind CSS v4 |
| Infrastructure | PostgreSQL · Redis · RustFS (S3-compatible) · Nginx |

## 📦 Repository Layout

```
backend/                       Backend source (Go)
├── cmd/
│   ├── api/                   Service entry point (main)
│   └── marklabel/             Ops helper (mark accounts on demand)
├── internal/
│   ├── bootstrap/             App wiring, scheduled maintenance startup
│   ├── config/                Env-var configuration loading
│   ├── http/
│   │   ├── handler/           HTTP handlers (v1-compatible API, admin, auth…)
│   │   ├── middleware/        Auth / request-id middleware
│   │   └── router/            Route registration
│   ├── model/                 GORM data models
│   ├── provider/              Upstream provider clients
│   │   ├── adobe/             Adobe Firefly (tls-client fingerprint)
│   │   ├── chatgpt/           OpenAI (incl. PoW / turnstile)
│   │   ├── runway/            Runway video + Nano Banana image
│   │   ├── grok/              Grok (grok.com, spoofed statsig, video)
│   │   ├── leonardo/          Leonardo
│   │   ├── krea/              Krea
│   │   ├── imagine/           Imagine.art
│   │   ├── custom/            Custom upstream (OpenAI-compatible v1, routed by id)
│   │   └── epay/              易支付 / epay (mapi order + MD5-verified callback, top-ups)
│   ├── repo/                  Data-access layer (users / models / accounts / logs / CDK / orders / concurrency groups…)
│   ├── service/               Business logic (scheduling, billing, account pools, keep-alive, maintenance)
│   └── storage/               RustFS / S3 media storage
├── Dockerfile                 Multi-stage build (compile source → slim runtime image)
└── .env.example               Backend env-var template

frontend/                      Frontend source (Vue 3 + Vite)
├── src/
│   ├── views/                 Pages (playground / accounts / models / users / concurrency / orders / logs / overview / top-up / settings…)
│   ├── components/            Reusable components (modals / selectors / lightbox…)
│   ├── layouts/               Public / admin layouts
│   ├── utils/                 Utility functions
│   └── api.js · auth.js …     API client, auth, theme, credits, etc.
├── Dockerfile                 Nginx static hosting (HTTP :2000) + API proxy
└── default.conf.template      Nginx site template (reverse proxy + caching)

docker-compose.yml             Docker orchestration (Postgres / Redis / RustFS / backend / frontend)
```

## 🗺️ Roadmap

- [ ] More upstream providers
- [ ] Usage analytics / export
- [ ] Multi-language UI (i18n)
- [ ] Webhook / async callbacks

## 💬 Community / Contact

| | |
|---|---|
| 🌐 Website | **[vividai.run](https://vividai.run)** |
| 👥 QQ Group | **1106849765** · [Join](https://qm.qq.com/q/976LeMFoHu) |
| 🐧 QQ | **1114639355** · [Add](https://qm.qq.com/q/ItgCcNA7ac) |
| 🛒 Shop | **[pay.ldxp.cn/shop/chiyi](https://pay.ldxp.cn/shop/chiyi)** |
| ✉️ Email | vividairun@gmail.com |

## ⭐ Star History

<!-- After creating the GitHub repo, uncomment the line below and replace OWNER with your username to show the chart: -->
<!-- [![Star History Chart](https://api.star-history.com/svg?repos=OWNER/image2api&type=Date)](https://star-history.com/#OWNER/image2api&Date) -->

If you find this useful, give it a ⭐ — uncomment the line above after creating the repo to show the Star History chart.

## 📄 License

This project (frontend + backend) is open-source under the [MIT](LICENSE) license — free to use, modify, commercialize and redistribute.

<div align="center">

If this project helps you, a ⭐ Star is much appreciated!

</div>
