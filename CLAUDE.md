# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # production
npm run dev      # development with auto-restart (node --watch)
```

No build step, no test suite, no linter configured.

## Environment

Copy `.env.example` to `.env` before running. Required variables:

- `UPLOAD_PASSWORD` — protects upload, delete, and edit operations
- `REGISTRY` — Docker registry hostname for `build.sh`
- `PORT` — host port (default 3000)
- `IMAGE_TAG` — image tag pulled on server (default latest)

## Architecture

Single-file backend (`server.js`) + two static HTML pages. No framework on the frontend, no database — all state lives in `data/videos.json`.

### Request flow

```
POST /upload          → busboy stream → uploads/{slug}{ext}
                      → ffmpeg thumbnail → thumbnails/{slug}.jpg
                      → append to data/videos.json

GET  /v/:slug         → Range-aware stream from uploads/
GET  /thumb/:slug     → serve thumbnails/{slug}.jpg
GET  /:slug           → serve public/watch.html (8-char hex slugs only)
GET  /api/videos      → reads videos.json, strips token field
POST /api/:slug/view  → increments views counter in videos.json
PATCH /api/:slug      → updates title, requires password or per-video token
DELETE /api/:slug     → removes file + thumbnail + JSON entry
POST /api/auth        → verifies UPLOAD_PASSWORD, used by index.html gate
```

### Auth model

`UPLOAD_PASSWORD` (env) is the single credential. It is checked via `X-Password` header on upload, and as the `token` query/body param on delete/edit. Per-video delete tokens (generated at upload time, stored in `videos.json`) are also accepted for backward compatibility.

The frontend stores the verified password in `sessionStorage` (key `sp`). `index.html` shows a full-screen gate until authenticated. `watch.html` uses the stored password silently if present, otherwise prompts inline.

### videos.json schema

```json
{
  "slug": "a1b2c3d4",
  "token": "<16-char hex>",
  "filename": "original.mp4",
  "title": "editable display name",
  "storedName": "a1b2c3d4.mp4",
  "size": 1234567,
  "mimeType": "video/mp4",
  "hasThumbnail": true,
  "views": 42,
  "uploadedAt": "2024-01-01T00:00:00.000Z"
}
```

`token` is never exposed via `GET /api/videos`.

### Thumbnail generation

`ffmpeg` is called as a child process at upload time (`-ss 00:00:01 -vframes 1 -vf scale=640:-1`). If `ffmpeg` is not installed, `hasThumbnail` is set to `false` and the app continues normally.

### Docker

`build.sh` — builds for `linux/amd64`, tags as `{REGISTRY}/streamable:{tag}` and `:latest`, pushes both.  
`docker-compose.yml` — three named volumes: `uploads`, `thumbnails`, `data`. Uses `image:` (not `build:`), so the server only needs the compose file and a `.env`.
