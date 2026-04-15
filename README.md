# streamable

Self-hosted video hosting platform for sharing game clips and short videos. No database, no framework — just Node.js, a JSON file, and flat file storage.

![Node.js](https://img.shields.io/badge/node-20+-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- Upload, stream, and share videos with a short link (`/a1b2c3d4`)
- Custom video player with seek, volume, speed, and chapter support
- Tags, search, and filter on the dashboard
- Public/private toggle per video
- Auto-tag suggestions based on existing tags matched against filename
- Public gallery page at `/gallery` (no auth required)
- Bulk select, multi-delete, and multi-tag operations
- Storage usage indicator
- Video info overlay (resolution, bitrate, size, etc.)
- Thumbnail generation via ffmpeg
- Docker-ready with named volumes

## Requirements

- Node.js 20+
- ffmpeg (optional — thumbnails are skipped if not installed)

## Getting Started

```bash
cp .env.example .env   # fill in PASSWORD
npm install
npm run dev            # development (auto-restart)
npm start              # production
```

Open [http://localhost:3000](http://localhost:3000) and enter your password.

## Environment Variables

| Variable        | Default  | Description                                  |
|-----------------|----------|----------------------------------------------|
| `PASSWORD`      | —        | Required. Protects upload, delete, and edit. |
| `PORT`          | `3000`   | Port the server listens on.                  |
| `MAX_UPLOAD_MB` | `1024`   | Max upload size in megabytes.                |
| `REGISTRY`      | —        | Docker registry hostname (used by `build.sh` only). |
| `IMAGE_TAG`     | `latest` | Image tag to pull (used by `docker-compose.prod.yml` only). |

## Docker Deployment

### Option 1 — Clone and run (recommended for self-hosting)

No registry needed. Docker builds the image locally.

```bash
git clone https://github.com/your-username/streamable
cd streamable
cp .env.example .env   # set PASSWORD
docker compose up -d
```

### Option 2 — Private registry

For those who maintain a private registry and deploy to a remote server.

**Build and push:**

```bash
./build.sh          # builds linux/amd64, tags :latest, pushes
./build.sh 1.2.3    # also tags :1.2.3
```

**On the server — only needs `docker-compose.prod.yml` and `.env`:**

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Data is persisted in three named volumes: `uploads`, `thumbnails`, `data`.

## Project Structure

```
server.js          # entire backend (single file)
public/
  index.html       # dashboard (upload, manage, search, filter)
  watch.html       # video player page
  gallery.html     # public gallery (no auth)
data/
  videos.json      # all video metadata
uploads/           # raw video files
thumbnails/        # generated jpg thumbnails
```

## API

| Method   | Path               | Auth     | Description                        |
|----------|--------------------|----------|------------------------------------|
| `POST`   | `/upload`          | Password | Upload a video                     |
| `GET`    | `/v/:slug`         | —        | Stream video (range-aware)         |
| `GET`    | `/thumb/:slug`     | —        | Serve thumbnail                    |
| `GET`    | `/dl/:slug`        | —        | Download video                     |
| `GET`    | `/api/videos`      | Optional | List videos (private filtered)     |
| `GET`    | `/api/stats`       | —        | Storage and view counts            |
| `POST`   | `/api/:slug/view`  | —        | Increment view counter             |
| `PATCH`  | `/api/:slug`       | Password | Update title, tags, chapters       |
| `DELETE` | `/api/:slug`       | Password | Delete video                       |
| `POST`   | `/api/auth`        | —        | Verify password                    |

## License

MIT
