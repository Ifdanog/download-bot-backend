#!/usr/bin/env node
/**
 * Simple YouTube downloader — paste a link, get the highest quality video.
 *
 * This calls the yt-dlp binary under the hood (via youtube-dl-exec), which
 * is actively maintained and updated frequently to keep up with YouTube's
 * changes — much more reliable long-term than pure-JS libraries like
 * ytdl-core, which break every time YouTube tweaks its obfuscation.
 *
 * Usage:
 *   node yt_download.js
 *   (then paste the URL when prompted)
 *
 *   or directly:
 *   node yt_download.js "https://www.youtube.com/watch?v=..."
 *
 * Setup:
 *   npm install youtube-dl-exec
 *   (this automatically downloads a yt-dlp binary on first install)
 *
 * Only use this on videos you own, have permission to download, or that
 * are licensed for it (Creative Commons, your own uploads, etc).
 * Downloading copyrighted videos without permission may violate YouTube's
 * Terms of Service and copyright law.
 */

const path = require("path");
const os = require("os");
const readline = require("readline");
const youtubedlExec = require("youtube-dl-exec");

// If you've installed yt-dlp separately (e.g. `brew install yt-dlp`), set its
// path here to avoid Python-version conflicts with the bundled binary.
// Find it with: which yt-dlp
const SYSTEM_YTDLP_PATH = "/opt/homebrew/bin/yt-dlp" || null; // e.g. "/opt/homebrew/bin/yt-dlp"

const youtubedl = SYSTEM_YTDLP_PATH
  ? youtubedlExec.create(SYSTEM_YTDLP_PATH)
  : youtubedlExec;

const OUTPUT_DIR = path.join(os.homedir(), "Downloads", "yt_downloads");

function promptForUrl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Paste YouTube link: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function download(url) {
  console.log("⬇️  Downloading best available quality (this merges video+audio automatically)...\n");

  const subprocess = youtubedl.exec(url, {
    // Prefer H.264 (avc1) video — QuickTime and most players don't handle
    // YouTube's VP9/AV1 streams, which is why you'd hear audio but see
    // nothing (or a black screen). Falls back to best available if no
    // H.264 stream exists at that resolution.
    format:
      "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]/bestvideo+bestaudio/best",
    mergeOutputFormat: "mp4",
    output: path.join(OUTPUT_DIR, "%(title)s.%(ext)s"),
    noPlaylist: true,
    newline: true,
  });

  // Stream yt-dlp's own progress output straight to the console
  subprocess.stdout.on("data", (chunk) => process.stdout.write(chunk.toString()));
  subprocess.stderr.on("data", (chunk) => process.stderr.write(chunk.toString()));

  await subprocess;
  console.log(`\n✅ Done. Check: ${OUTPUT_DIR}`);
}

(async () => {
  const argUrl = process.argv[2];
  const url = argUrl || (await promptForUrl());

  if (!url) {
    console.error("No URL provided.");
    process.exit(1);
  }

  try {
    await download(url);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
})();