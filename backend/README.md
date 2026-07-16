# Vivid AI Backend

Go backend for `vivid-ai`, using:

- Gin
- GORM
- PostgreSQL
- Redis

## Current scope

This is an in-progress rewrite. The current skeleton already includes:

- app bootstrap
- PostgreSQL and Redis initialization
- GORM auto-migrations
- session storage in Redis
- image access control for `/images/:user/:name`
- public site endpoint: `/admin/api/site`
- public showcase endpoint: `/admin/api/showcase`
- session-based auth endpoint: `/admin/api/auth/me`

## Environment

Set these before running:

```powershell
$env:POSTGRES_DSN="host=127.0.0.1 user=postgres password=postgres dbname=vivid_ai port=5432 sslmode=disable TimeZone=Asia/Shanghai"
$env:REDIS_ADDR="127.0.0.1:6379"
$env:HTTP_ADDR=":6061"
```

Optional:

```powershell
$env:APP_ENV="development"
$env:APP_TITLE="Vivid AI"
$env:SESSION_COOKIE_NAME="vivid_session"
$env:CORS_ORIGINS="http://localhost:5173,http://127.0.0.1:5173"
$env:IMAGE_URL_SIGNING_KEY="change-me" # defaults to RUSTFS_SECRET_KEY
$env:IMAGE_URL_TTL_MINUTES="60"
```

## Run

```powershell
go run ./cmd/api
```

## Notes

- Generated media defaults to `../../ai-gateway/data/generated` relative to the backend working directory.
- Stored private images under `/images/` require a browser session cookie.
- API image proxy URLs under `/v1/images/{id}/content` accept the originating
  API key or a short-lived HMAC signature returned by the generation endpoint.
- `response_format=b64_json` returns image bytes inline instead of a URL.
- Showcase images are public.
