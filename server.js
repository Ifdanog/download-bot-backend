/**
 * Simple backend for the YouTube downloader frontend.
 *
 * Endpoints:
 *   GET /api/download?url=<youtube-url>
 *     -> Server-Sent Events stream of progress lines, ending with a
 *        "done" event containing the downloadable filename.
 *   GET /downloads/<filename>
 *     -> Serves the finished file (static).
 *
 * Setup:
 *   npm install
 *   (optional, recommended) brew install yt-dlp ffmpeg
 *   YTDLP_PATH=/opt/homebrew/bin/yt-dlp node server.js
 *
 * Then open http://localhost:3000 in a browser.
 *
 * Only use this on videos you own, have permission to download, or that
 * are licensed for it. Downloading copyrighted videos without permission
 * may violate YouTube's Terms of Service and copyright law.
 */

/**
 * Backend for the YouTube downloader frontend.
 *
 * Endpoints:
 *   GET /api/info?url=<youtube-url>
 *     -> JSON with title, thumbnail, quality label, and estimated file size
 *        (fetched via yt-dlp's --dump-json, no actual download happens).
 *   GET /api/thumbnail?url=<youtube-url>
 *     -> Streams the highest-res thumbnail as a forced download.
 *   GET /api/download?url=<youtube-url>
 *     -> Server-Sent Events stream of progress lines, ending with a
 *        "done" event containing the downloadable filename.
 *   GET /downloads/<filename>
 *     -> Serves the finished file (static).
 *
 * Setup:
 *   npm install
 *   (recommended) brew install yt-dlp ffmpeg
 *   YTDLP_PATH=/opt/homebrew/bin/yt-dlp node server.js
 *
 * Then open http://localhost:3000 in a browser.
 *
 * Only use this on videos you own, have permission to download, or that
 * are licensed for it. Downloading copyrighted videos without permission
 * may violate YouTube's Terms of Service and copyright law.
 */

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const youtubedlExec = require("../frontend/node_modules/youtube-dl-exec/src");

const SYSTEM_YTDLP_PATH = process.env.YTDLP_PATH || null; // e.g. "/opt/homebrew/bin/yt-dlp"
const youtubedl = SYSTEM_YTDLP_PATH ? youtubedlExec.create(SYSTEM_YTDLP_PATH) : youtubedlExec;

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// Prefer H.264 (avc1) video for broad player compatibility (QuickTime etc.
// don't handle VP9/AV1), falling back to whatever's best if unavailable.
const FORMAT_STRING =
  "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]/bestvideo+bestaudio/best";

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOAD_DIR));

function isValidYoutubeUrl(url) {
  return /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/.test(url);
}

function humanFileSize(bytes) {
  if (!bytes || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[i]}`;
}

// ---- GET /api/info ----
app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidYoutubeUrl(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL." });
  }

  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noPlaylist: true,
    });

    // Best available audio-only stream — used to estimate combined size
    // for every video quality option below.
    const audioFormats = (info.formats || []).filter(
      (f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none")
    );
    const bestAudio = audioFormats.sort(
      (a, b) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0)
    )[0];
    const audioBytes = bestAudio ? bestAudio.filesize || bestAudio.filesize_approx || 0 : 0;

    // H.264 (avc1) video-only formats, deduped by height keeping the
    // largest (best bitrate) per resolution — matches what /api/download
    // will actually fetch, so the size estimate lines up.
    const videoFormats = (info.formats || []).filter(
      (f) =>
        f.vcodec &&
        f.vcodec.startsWith("avc1") &&
        (!f.acodec || f.acodec === "none") &&
        f.height
    );

    const byHeight = {};
    for (const f of videoFormats) {
      const bytes = f.filesize || f.filesize_approx || 0;
      if (!byHeight[f.height] || bytes > byHeight[f.height].bytes) {
        byHeight[f.height] = { bytes, fps: f.fps };
      }
    }

    const qualities = Object.entries(byHeight)
      .map(([height, data]) => {
        const totalBytes = data.bytes + audioBytes;
        return {
          height: parseInt(height, 10),
          label: `${height}p${data.fps && data.fps > 30 ? Math.round(data.fps) : ""}`,
          filesizeBytes: totalBytes || null,
          filesizeHuman: humanFileSize(totalBytes) || "Unknown",
        };
      })
      .sort((a, b) => b.height - a.height)
      .slice(0, 6);

    // Pick the highest-resolution thumbnail available.
    const thumbnails = info.thumbnails || [];
    const bestThumb =
      thumbnails.length > 0
        ? thumbnails.reduce((a, b) => ((a.width || 0) > (b.width || 0) ? a : b))
        : { url: info.thumbnail };

    res.json({
      title: info.title,
      thumbnail: bestThumb.url,
      durationSeconds: info.duration || null,
      qualities,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- GET /api/thumbnail ----
app.get("/api/thumbnail", async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidYoutubeUrl(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL." });
  }

  try {
    const info = await youtubedl(url, { dumpSingleJson: true, noPlaylist: true });
    const thumbnails = info.thumbnails || [];
    const bestThumb =
      thumbnails.length > 0
        ? thumbnails.reduce((a, b) => ((a.width || 0) > (b.width || 0) ? a : b))
        : { url: info.thumbnail };

    const imgRes = await fetch(bestThumb.url);
    if (!imgRes.ok) throw new Error("Could not fetch thumbnail.");

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const safeTitle = (info.title || "thumbnail").replace(/[\\/:*?"<>|]/g, "_");
    const ext = bestThumb.url.includes(".webp") ? "webp" : "jpg";

    res.setHeader("Content-Type", imgRes.headers.get("content-type") || "image/jpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${ext}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- GET /api/download ----
app.get("/api/download", (req, res) => {
  const { url, height } = req.query;

  if (!url || !isValidYoutubeUrl(url)) {
    res.status(400).json({ error: "Invalid or missing YouTube URL." });
    return;
  }

  // If the user picked a specific resolution, cap the video format to it;
  // otherwise fall back to the original "best available" string.
  const selectedFormat = height
    ? `bestvideo[vcodec^=avc1][height<=${height}]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`
    : FORMAT_STRING;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const jobId = Date.now().toString();
  const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}-%(title)s.%(ext)s`);

  send("status", { message: "Fetching video info..." });

  const subprocess = youtubedl.exec(url, {
    format: selectedFormat,
    mergeOutputFormat: "mp4",
    output: outputTemplate,
    noPlaylist: true,
    newline: true,
  });

  subprocess.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    const progressMatch = text.match(/\[download\]\s+([\d.]+)%/);
    if (progressMatch) {
      send("progress", { percent: parseFloat(progressMatch[1]) });
    } else if (text.trim()) {
      send("status", { message: text.trim() });
    }
  });

  subprocess.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) send("status", { message: text });
  });

  subprocess
    .then(() => {
      const files = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.startsWith(jobId));
      const finalFile = files.find((f) => f.endsWith(".mp4")) || files[0];

      if (!finalFile) {
        send("error", { message: "Download finished but no output file was found." });
        res.end();
        return;
      }

      send("done", {
        filename: finalFile,
        url: `/downloads/${encodeURIComponent(finalFile)}`,
      });
      res.end();
    })
    .catch((err) => {
      send("error", { message: err.message });
      res.end();
    });

  req.on("close", () => {
    subprocess.kill();
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});