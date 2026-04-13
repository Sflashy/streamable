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

Open [http://localhost:3000](http://localhost:3000) and enter your upload password.

## Environment Variables

| Variable          | Default  | Description                                      |
|-------------------|----------|--------------------------------------------------|
| `PASSWORD`        | —        | Required. Protects upload, delete, and edit.     |
| `PORT`            | `3000`   | Port the server listens on.                      |
| `REGISTRY`        | —        | Docker registry hostname used by `build.sh`.     |
| `IMAGE_TAG`       | `latest` | Image tag pulled on the server.                  |

## Docker Deployment

**On your build machine:**

```bash
./build.sh          # builds linux/amd64, tags as :latest, pushes
./build.sh 1.2.3    # also tags as :1.2.3
```

**On the server — only needs `docker-compose.yml` and `.env`:**

```bash
docker compose pull
docker compose up -d
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
