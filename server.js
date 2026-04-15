import express from 'express';
import busboy from 'busboy';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const THUMBS_DIR  = path.join(__dirname, 'thumbnails');
const DATA_DIR    = path.join(__dirname, 'data');
const DATA_FILE   = path.join(DATA_DIR, 'videos.json');
const PUBLIC_DIR  = path.join(__dirname, 'public');

const UPLOAD_LIMIT_MB = parseInt(process.env.MAX_UPLOAD_MB || '1024', 10);
const UPLOAD_LIMIT    = UPLOAD_LIMIT_MB * 1024 * 1024;
const PASSWORD = process.env.PASSWORD || '';

const uploadEvents = new Map(); // uploadId → SSE res

function sendUploadEvent(id, data) {
  const res = uploadEvents.get(id);
  if (res) res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function checkPassword(provided) {
  return PASSWORD !== '' && provided === PASSWORD;
}

// Escape string for use in HTML attribute values
function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Startup ───────────────────────────────────────────────────────────────────
let watchTemplate = '';

async function init() {
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  await fsp.mkdir(THUMBS_DIR,  { recursive: true });
  await fsp.mkdir(DATA_DIR,    { recursive: true });
  try { await fsp.access(DATA_FILE); }
  catch { await fsp.writeFile(DATA_FILE, JSON.stringify([])); }
  watchTemplate = await fsp.readFile(path.join(PUBLIC_DIR, 'watch.html'), 'utf8');
}

// ── ffmpeg / ffprobe helpers ──────────────────────────────────────────────────
function generateThumbnail(inputPath, outputPath) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-i', inputPath, '-ss', '00:00:01', '-vframes', '1',
      '-vf', 'scale=640:-1', '-q:v', '4', '-y', outputPath,
    ]);
    ff.on('close', (code) => resolve(code === 0));
    ff.on('error', () => resolve(false));
  });
}

function normalizeToH264(inputPath, outputPath) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-y', outputPath,
    ]);
    ff.on('close', (code) => resolve(code === 0));
    ff.on('error', () => resolve(false));
  });
}

function probeVideo(inputPath) {
  return new Promise((resolve) => {
    const ff = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_streams', '-show_format', inputPath,
    ]);
    let out = '';
    ff.stdout.on('data', d => { out += d; });
    ff.on('close', (code) => {
      if (code !== 0) return resolve({});
      try {
        const data = JSON.parse(out);
        const vs   = data.streams?.find(s => s.codec_type === 'video');
        resolve({
          duration:   Math.round(parseFloat(data.format?.duration) || 0),
          width:      vs?.width      || 0,
          height:     vs?.height     || 0,
          videoCodec: vs?.codec_name || null,
        });
      } catch { resolve({}); }
    });
    ff.on('error', () => resolve({}));
  });
}

// ── Auto-tag from filename ────────────────────────────────────────────────────
// Matches existing tag names (case-insensitive) against the uploaded filename.
function matchTagsFromFilename(filename, existingTags) {
  const name = filename.toLowerCase().replace(/[._\-]/g, ' ');
  return existingTags.filter(tag => name.includes(tag.toLowerCase()));
}

// ── JSON helpers ──────────────────────────────────────────────────────────────
async function readVideos() {
  const raw = await fsp.readFile(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeVideos(videos) {
  await fsp.writeFile(DATA_FILE, JSON.stringify(videos, null, 2));
}

function genSlug(bytes = 4)  { return crypto.randomBytes(bytes).toString('hex'); }
function genToken(bytes = 8) { return crypto.randomBytes(bytes).toString('hex'); }

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// ── GET /api/upload-events/:id — SSE stream for upload progress ───────────────
app.get('/api/upload-events/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  uploadEvents.set(req.params.id, res);
  req.on('close', () => uploadEvents.delete(req.params.id));
});

// ── POST /api/auth ────────────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (checkPassword(password)) return res.json({ ok: true });
  res.status(401).json({ error: 'Wrong password.' });
});

// ── POST /upload ──────────────────────────────────────────────────────────────
app.post('/upload', (req, res) => {
  if (!checkPassword(req.headers['x-password'])) {
    return res.status(401).json({ error: 'Wrong password.' });
  }

  const uploadId = req.headers['x-upload-id'] || null;
  const bb = busboy({ headers: req.headers, limits: { fileSize: UPLOAD_LIMIT } });
  let fileStarted = false;
  let fileError   = null;
  let limitHit    = false;

  bb.on('file', (_fieldname, stream, info) => {
    const { filename, mimeType } = info;

    if (!mimeType.startsWith('video/')) {
      stream.resume();
      fileError = { status: 400, message: 'Only video files are accepted.' };
      return;
    }

    const slug       = genSlug();
    const token      = genToken();
    const ext        = path.extname(filename) || '.mp4';
    const storedName = `${slug}${ext}`;
    const destPath   = path.join(UPLOADS_DIR, storedName);

    fileStarted = true;

    stream.on('limit', async () => {
      limitHit = true;
      stream.resume();
      try { await fsp.unlink(destPath); } catch {}
      if (!res.headersSent)
        res.status(413).json({ error: `File exceeds the ${UPLOAD_LIMIT_MB} MB upload limit.` });
    });

    const writeStream = fs.createWriteStream(destPath);
    stream.pipe(writeStream);

    writeStream.on('finish', async () => {
      if (limitHit) return;

      // Probe codec first so we know whether to transcode
      sendUploadEvent(uploadId, { phase: 'analyzing' });
      const probe = await probeVideo(destPath);

      // Normalize to H.264 MP4: remux-only if already H.264, full transcode otherwise
      const normalizedPath = path.join(UPLOADS_DIR, `${slug}_norm.mp4`);
      let normOk = false;
      if (probe.videoCodec) {
        sendUploadEvent(uploadId, { phase: 'transcoding' });
        normOk = await normalizeToH264(destPath, normalizedPath);
      }

      let finalPath       = destPath;
      let finalStoredName = storedName;
      let finalMimeType   = mimeType;

      if (normOk) {
        await fsp.unlink(destPath).catch(() => {});
        finalPath       = path.join(UPLOADS_DIR, `${slug}.mp4`);
        finalStoredName = `${slug}.mp4`;
        finalMimeType   = 'video/mp4';
        await fsp.rename(normalizedPath, finalPath);
      }

      sendUploadEvent(uploadId, { phase: 'finishing' });
      const thumbPath = path.join(THUMBS_DIR, `${slug}.jpg`);
      const [hasThumbnail, stat, videos] = await Promise.all([
        generateThumbnail(finalPath, thumbPath),
        fsp.stat(finalPath),
        readVideos(),
      ]);

      const existingTags = [...new Set(videos.flatMap(v => v.tags || []))];
      const baseName     = filename || storedName;

      const meta = {
        slug,
        token,
        filename:     baseName,
        title:        baseName,
        storedName:   finalStoredName,
        size:         stat.size,
        mimeType:     finalMimeType,
        hasThumbnail,
        duration:     probe.duration || 0,
        width:        probe.width    || 0,
        height:       probe.height   || 0,
        tags:         matchTagsFromFilename(baseName, existingTags),
        chapters:     [],
        private:      false,
        views:        0,
        uploadedAt:   new Date().toISOString(),
      };

      videos.unshift(meta);
      await writeVideos(videos);

      uploadEvents.delete(uploadId);
      res.json({ slug, url: `/${slug}`, deleteUrl: `/api/${slug}?token=${token}` });
    });

    writeStream.on('error', (err) => {
      console.error('Write error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Write failed.' });
    });
  });

  bb.on('finish', () => {
    if (fileError && !res.headersSent)
      res.status(fileError.status).json({ error: fileError.message });
    if (!fileStarted && !fileError && !res.headersSent)
      res.status(400).json({ error: 'No file received.' });
  });

  bb.on('error', (err) => {
    console.error('Busboy error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Upload failed.' });
  });

  req.pipe(bb);
});

// ── GET /api/stats ────────────────────────────────────────────────────────────
app.get('/api/stats', async (_, res) => {
  try {
    const videos     = await readVideos();
    const totalSize  = videos.reduce((s, v) => s + (v.size || 0), 0);
    const totalViews = videos.reduce((s, v) => s + (v.views || 0), 0);
    res.json({ count: videos.length, totalSize, totalViews, maxUploadMb: UPLOAD_LIMIT_MB });
  } catch {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── GET /api/videos ───────────────────────────────────────────────────────────
app.get('/api/videos', async (req, res) => {
  try {
    const videos = await readVideos();
    const authed = checkPassword(req.headers['x-password']);
    const visible = authed ? videos : videos.filter(v => !v.private);
    res.json(visible.map(({ slug, filename, title, size, mimeType,
                            hasThumbnail, duration, width, height, tags, chapters, private: priv, views, uploadedAt }) => ({
      slug,
      filename,
      title: title || filename,
      size,
      mimeType,
      hasThumbnail,
      duration:  duration || 0,
      width:     width    || 0,
      height:    height   || 0,
      tags:      tags      || [],
      chapters:  chapters  || [],
      private:   priv      || false,
      views:     views    || 0,
      uploadedAt,
    })));
  } catch {
    res.status(500).json({ error: 'Could not read video list.' });
  }
});

// ── POST /api/:slug/view ──────────────────────────────────────────────────────
app.post('/api/:slug/view', async (req, res) => {
  const { slug } = req.params;
  try {
    const videos = await readVideos();
    const video  = videos.find(v => v.slug === slug);
    if (!video) return res.status(404).json({ error: 'Not found.' });
    video.views = (video.views || 0) + 1;
    await writeVideos(videos);
    res.json({ views: video.views });
  } catch {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── PATCH /api/:slug — update title and/or tags ───────────────────────────────
app.patch('/api/:slug', async (req, res) => {
  const { slug }               = req.params;
  const { token, title, tags, chapters, private: priv } = req.body;

  if (title !== undefined && !title.trim())
    return res.status(400).json({ error: 'Title cannot be empty.' });

  if (tags !== undefined && !Array.isArray(tags))
    return res.status(400).json({ error: 'Tags must be an array.' });

  try {
    const videos = await readVideos();
    const video  = videos.find(v => v.slug === slug);
    if (!video) return res.status(404).json({ error: 'Not found.' });
    if (!checkPassword(token) && video.token !== token)
      return res.status(403).json({ error: 'Wrong password or invalid token.' });

    if (title    !== undefined) video.title    = title.trim();
    if (tags     !== undefined) video.tags     = tags.map(t => t.trim()).filter(Boolean);
    if (chapters !== undefined) video.chapters = chapters.map(c => ({ time: Number(c.time), label: String(c.label).trim() })).filter(c => !isNaN(c.time) && c.label);
    if (priv     !== undefined) video.private  = Boolean(priv);

    await writeVideos(videos);
    res.json({ ok: true, title: video.title, tags: video.tags, chapters: video.chapters, private: video.private });
  } catch {
    res.status(500).json({ error: 'Update failed.' });
  }
});

// ── DELETE /api/:slug ─────────────────────────────────────────────────────────
app.delete('/api/:slug', async (req, res) => {
  const { slug }  = req.params;
  const { token } = req.query;

  try {
    const videos = await readVideos();
    const idx    = videos.findIndex(v => v.slug === slug);

    if (idx === -1) return res.status(404).json({ error: 'Not found.' });

    const video = videos[idx];
    if (!checkPassword(token) && video.token !== token)
      return res.status(403).json({ error: 'Wrong password or invalid token.' });

    const filePath  = path.join(UPLOADS_DIR, video.storedName);
    const thumbPath = path.join(THUMBS_DIR, `${slug}.jpg`);
    await Promise.all([
      fsp.unlink(filePath).catch(() => {}),
      fsp.unlink(thumbPath).catch(() => {}),
    ]);

    videos.splice(idx, 1);
    await writeVideos(videos);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed.' });
  }
});

// ── GET /thumb/:slug ──────────────────────────────────────────────────────────
app.get('/thumb/:slug', async (req, res) => {
  const thumbPath = path.join(THUMBS_DIR, `${req.params.slug}.jpg`);
  try {
    await fsp.access(thumbPath);
    res.sendFile(thumbPath);
  } catch {
    res.status(404).end();
  }
});

// ── GET /dl/:slug — download ──────────────────────────────────────────────────
app.get('/dl/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const videos = await readVideos();
    const video  = videos.find(v => v.slug === slug);
    if (!video) return res.status(404).end();

    const filePath = path.join(UPLOADS_DIR, video.storedName);
    try { await fsp.access(filePath); } catch { return res.status(404).end(); }

    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(video.filename)}`);
    res.setHeader('Content-Type', video.mimeType || 'video/mp4');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).end();
  }
});

// ── GET /v/:slug — stream with Range support ──────────────────────────────────
app.get('/v/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const videos = await readVideos();
    const video  = videos.find(v => v.slug === slug);
    if (!video) return res.status(404).json({ error: 'Video not found.' });

    const filePath = path.join(UPLOADS_DIR, video.storedName);
    let stat;
    try { stat = await fsp.stat(filePath); }
    catch { return res.status(404).json({ error: 'File missing.' }); }

    const fileSize = stat.size;
    const range    = req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start     = parseInt(startStr, 10);
      const end       = endStr ? parseInt(endStr, 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   video.mimeType || 'video/mp4',
      });
      fs.createReadStream(filePath, { start, end, highWaterMark: 512 * 1024 }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type':   video.mimeType || 'video/mp4',
        'Accept-Ranges':  'bytes',
      });
      fs.createReadStream(filePath, { highWaterMark: 512 * 1024 }).pipe(res);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Stream failed.' });
  }
});

// ── GET /gallery ──────────────────────────────────────────────────────────────
app.get('/gallery', (_, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'gallery.html'));
});

// ── GET /:slug — watch page with OG meta tags ─────────────────────────────────
app.get('/:slug([a-f0-9]{8})', async (req, res) => {
  const { slug } = req.params;

  try {
    const videos = await readVideos();
    const video  = videos.find(v => v.slug === slug);

    if (!video) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(watchTemplate);
    }

    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host  = req.headers['x-forwarded-host']  || req.get('host');
    const base  = `${proto}://${host}`;
    const title = escAttr(video.title || video.filename);
    const vw    = video.width  || 1280;
    const vh    = video.height || 720;

    const ogTags = [
      `<meta property="og:type"              content="video.other" />`,
      `<meta property="og:site_name"         content="Streamable" />`,
      `<meta property="og:title"             content="${title}" />`,
      `<meta property="og:video"             content="${base}/v/${slug}" />`,
      `<meta property="og:video:secure_url"  content="${base}/v/${slug}" />`,
      `<meta property="og:video:type"        content="${escAttr(video.mimeType || 'video/mp4')}" />`,
      `<meta property="og:video:width"       content="${vw}" />`,
      `<meta property="og:video:height"      content="${vh}" />`,
      video.hasThumbnail
        ? `<meta property="og:image"         content="${base}/thumb/${slug}" />`
        : '',
      `<meta name="twitter:card"             content="player" />`,
      `<meta name="twitter:title"            content="${title}" />`,
      `<meta name="twitter:player"           content="${base}/${slug}" />`,
      `<meta name="twitter:player:width"     content="${vw}" />`,
      `<meta name="twitter:player:height"    content="${vh}" />`,
      video.hasThumbnail
        ? `<meta name="twitter:image"        content="${base}/thumb/${slug}" />`
        : '',
    ].filter(Boolean).join('\n  ');

    const html = watchTemplate
      .replace('<title>Streamable — Watch</title>', `<title>${title} — Streamable</title>`)
      .replace('</head>', `  ${ogTags}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(watchTemplate);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
init().then(() => {
  app.listen(PORT, () => console.log(`Streamable running → http://localhost:${PORT}`));
});
