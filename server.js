require("dotenv").config();

/**
 * Backend for the YouTube downloader frontend.
 *
 * Endpoints:
 *   GET /api/info?url=<youtube-url>
 *     -> JSON with title, thumbnail, and quality options with estimated
 *        file sizes (via yt-dlp --dump-json, no download happens).
 *   GET /api/thumbnail?url=<youtube-url>
 *     -> Streams the highest-res thumbnail as a forced download.
 *   GET /api/download?url=<youtube-url>&height=<optional>
 *     -> Server-Sent Events stream of progress, ending with "done".
 *   GET /downloads/<filename>
 *     -> Serves the finished file (static, auto-deleted after MAX_FILE_AGE_MS).
 *   GET /health
 *     -> Basic health check, confirms yt-dlp is reachable.
 *
 * Setup:
 *   npm install
 *   (recommended) brew install yt-dlp ffmpeg      [macOS]
 *   Set YTDLP_PATH in a .env file (see .env.example)
 *   node server.js
 *
 * Only use this on videos you own, have permission to download, or that
 * are licensed for it. Downloading copyrighted videos without permission
 * may violate YouTube's Terms of Service and copyright law.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const express = require("express");
const cors = require("cors");
const youtubedlExec = require("youtube-dl-exec");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // lock this down in production
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "3", 10);
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.DOWNLOAD_TIMEOUT_MS || "600000", 10); // 10 min
const MAX_FILE_AGE_MS = parseInt(process.env.MAX_FILE_AGE_MS || "1800000", 10); // 30 min
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // sweep every 5 min

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// Resolve the yt-dlp binary: explicit env var wins, otherwise fall back to
// whatever's on PATH (works on Render/Linux where it's installed via pip
// during build, and on macOS/Homebrew if YTDLP_PATH isn't set).
function resolveYtdlpPath() {
  const configured = process.env.YTDLP_PATH;
  if (configured) return configured;

  try {
    const found = execSync(os.platform() === "win32" ? "where yt-dlp" : "which yt-dlp")
      .toString()
      .trim()
      .split("\n")[0];
    if (found) return found;
  } catch (_) {
    // fall through
  }
  return null; // let youtube-dl-exec use its bundled binary as last resort
}

const YTDLP_PATH = resolveYtdlpPath();
const youtubedl = YTDLP_PATH ? youtubedlExec.create(YTDLP_PATH) : youtubedlExec;

// Extra args that help yt-dlp survive YouTube's frequent client-blocking
// changes. Applied consistently across every yt-dlp call.
const EXTRACTOR_ARGS = ["youtube:player_client=tv"];

// Prefer H.264 (avc1) video for broad player compatibility (QuickTime etc.
// don't handle VP9/AV1), falling back to whatever's best if unavailable.
const FORMAT_STRING =
  "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]/bestvideo+bestaudio/best";

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------

(async () => {
  try {
    const version = await youtubedl("--version", { noCheckCertificates: true }).catch(() =>
      // some yt-dlp wrappers don't like being called with a flag as the
      // first positional arg; fall back to the raw exec form
      youtubedl.exec(["--version"])
    );
    console.log(`✅ yt-dlp reachable (path: ${YTDLP_PATH || "bundled"})`);
  } catch (err) {
    console.warn(
      `⚠️  Could not confirm yt-dlp is working (${err.message}). ` +
        `Downloads will likely fail until this is fixed. Check YTDLP_PATH.`
    );
  }
})();

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(",").map((o) => o.trim()),
  })
);
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOAD_DIR));

let activeDownloads = 0;

function isValidYoutubeUrl(url) {
  if (typeof url !== "string" || url.length > 500) return false;
  return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]+/.test(url);
}

function isValidHeight(height) {
  if (height === undefined) return true;
  return /^\d{2,4}$/.test(height);
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

// Translate common yt-dlp/network failures into messages a user can act on.
function friendlyError(err) {
  const msg = (err && err.message) || String(err);

  if (/unsupported version of python/i.test(msg)) {
    return "The server's yt-dlp is running on an unsupported Python version. Set YTDLP_PATH to a standalone yt-dlp binary (see setup notes).";
  }
  if (/ENOENT/i.test(msg) || /command not found/i.test(msg)) {
    return "yt-dlp binary not found on the server. Check that YTDLP_PATH is set correctly and yt-dlp is installed.";
  }
  if (/private video/i.test(msg)) {
    return "This video is private and can't be downloaded.";
  }
  if (/sign in to confirm your age/i.test(msg) || /age[- ]restrict/i.test(msg)) {
    return "This video is age-restricted and can't be downloaded without an authenticated session.";
  }
  if (/video unavailable/i.test(msg)) {
    return "This video is unavailable (removed, region-blocked, or an invalid link).";
  }
  if (/timed out|timeout/i.test(msg)) {
    return "The download took too long and was stopped. Try a lower quality or try again.";
  }
  return "Something went wrong processing this video. Double-check the link and try again.";
}

// ---------------------------------------------------------------------------
// Background cleanup — delete finished files after MAX_FILE_AGE_MS so a
// long-running server doesn't quietly fill up its disk.
// ---------------------------------------------------------------------------

function cleanupOldFiles() {
  fs.readdir(DOWNLOAD_DIR, (err, files) => {
    if (err) return;
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(DOWNLOAD_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (now - stats.mtimeMs > MAX_FILE_AGE_MS) {
          fs.unlink(filePath, () => {});
        }
      });
    }
  });
}
setInterval(cleanupOldFiles, CLEANUP_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", async (req, res) => {
  res.json({ ok: true, ytdlpPath: YTDLP_PATH || "bundled", activeDownloads });
});

app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!isValidYoutubeUrl(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL." });
  }

  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true,
      extractorArgs: EXTRACTOR_ARGS,
    });

    const audioFormats = (info.formats || []).filter(
      (f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none")
    );
    const bestAudio = audioFormats.sort(
      (a, b) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0)
    )[0];
    const audioBytes = bestAudio ? bestAudio.filesize || bestAudio.filesize_approx || 0 : 0;

    const videoFormats = (info.formats || []).filter(
      (f) => f.vcodec && f.vcodec.startsWith("avc1") && (!f.acodec || f.acodec === "none") && f.height
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
    console.error("[/api/info]", err.message);
    res.status(502).json({ error: friendlyError(err) });
  }
});

app.get("/api/thumbnail", async (req, res) => {
  const { url } = req.query;
  if (!isValidYoutubeUrl(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL." });
  }

  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true,
      extractorArgs: EXTRACTOR_ARGS,
    });
    const thumbnails = info.thumbnails || [];
    const bestThumb =
      thumbnails.length > 0
        ? thumbnails.reduce((a, b) => ((a.width || 0) > (b.width || 0) ? a : b))
        : { url: info.thumbnail };

    if (!bestThumb?.url) {
      return res.status(404).json({ error: "No thumbnail available for this video." });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const imgRes = await fetch(bestThumb.url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!imgRes.ok) throw new Error("Could not fetch thumbnail from source.");

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const safeTitle = (info.title || "thumbnail").replace(/[\\/:*?"<>|]/g, "_").slice(0, 150);
    const ext = bestThumb.url.includes(".webp") ? "webp" : "jpg";

    res.setHeader("Content-Type", imgRes.headers.get("content-type") || "image/jpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${ext}"`);
    res.send(buffer);
  } catch (err) {
    console.error("[/api/thumbnail]", err.message);
    res.status(502).json({ error: friendlyError(err) });
  }
});

app.get("/api/download", (req, res) => {
  const { url, height } = req.query;

  if (!isValidYoutubeUrl(url)) {
    res.status(400).json({ error: "Invalid or missing YouTube URL." });
    return;
  }
  if (!isValidHeight(height)) {
    res.status(400).json({ error: "Invalid quality parameter." });
    return;
  }
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    res.status(429).json({ error: "Server is busy with other downloads. Try again shortly." });
    return;
  }

  const selectedFormat = height
    ? `bestvideo[vcodec^=avc1][height<=${height}]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`
    : FORMAT_STRING;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable buffering on proxies like nginx/Render
  });

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat comment every 20s so idle proxies (Render, browsers) don't
  // time out the connection during long downloads with sparse output.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 20000);

  activeDownloads++;
  let finished = false;

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}-%(title).150B.%(ext)s`);

  send("status", { message: "Fetching video info..." });

  const subprocess = youtubedl.exec(url, {
    format: selectedFormat,
    mergeOutputFormat: "mp4",
    output: outputTemplate,
    noPlaylist: true,
    newline: true,
    restrictFilenames: true,
    extractorArgs: EXTRACTOR_ARGS,
  });

  const timeoutTimer = setTimeout(() => {
    if (!finished) {
      send("error", { message: friendlyError(new Error("timeout")) });
      subprocess.kill("SIGKILL");
    }
  }, DOWNLOAD_TIMEOUT_MS);

  function cleanupJob() {
    finished = true;
    clearTimeout(timeoutTimer);
    clearInterval(heartbeat);
    activeDownloads = Math.max(0, activeDownloads - 1);
  }

  subprocess.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    const progressMatch = text.match(/\[download\]\s+([\d.]+)%/);
    if (progressMatch) {
      send("progress", { percent: parseFloat(progressMatch[1]) });
    } else if (text.trim()) {
      send("status", { message: text.trim().slice(0, 300) });
    }
  });

  subprocess.stderr?.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) send("status", { message: text.slice(0, 300) });
  });

  subprocess.on("error", (err) => {
    // spawn-level failure, e.g. binary not found
    console.error("[/api/download] spawn error", err.message);
    send("error", { message: friendlyError(err) });
    cleanupJob();
    res.end();
  });

  subprocess
    .then(() => {
      if (finished) return; // already handled by timeout/kill
      cleanupJob();

      fs.readdir(DOWNLOAD_DIR, (err, files) => {
        if (err) {
          send("error", { message: "Download finished but the output folder could not be read." });
          res.end();
          return;
        }
        const jobFiles = files.filter((f) => f.startsWith(jobId));
        const finalFile = jobFiles.find((f) => f.endsWith(".mp4")) || jobFiles[0];

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
      });
    })
    .catch((err) => {
      if (finished) return; // already reported (e.g. timeout)
      console.error("[/api/download]", err.message);
      cleanupJob();
      send("error", { message: friendlyError(err) });
      res.end();
    });

  req.on("close", () => {
    if (!finished) {
      cleanupJob();
      subprocess.kill("SIGKILL");
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling & graceful shutdown
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error." });
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

const server = app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref(); // force exit if hung
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));