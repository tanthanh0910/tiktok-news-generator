# CLAUDE.md — Rules cho dự án TikTok News Generator

> File này dành cho **Claude session mới** hoặc **dev mới vào dự án**. Đọc 1 lượt là làm được.

## 1. Tổng quan

Tự động tạo video TikTok dạng tin tức từ link bài báo Việt Nam.

**Pipeline**: Crawl bài → Ollama viết script → Edge TTS đọc → Subtitle → ffmpeg render video 9:16 → upload YouTube/TikTok.

**Output**: `outputs/<jobId>/video.mp4` (1080×1920) + audio + SRT + 5 hashtag.

## 2. Tech stack

- **Next.js 14** App Router + **TypeScript** strict
- **Ollama** `llama3.1:latest` chạy local (LLM, miễn phí)
- **Edge TTS** (`msedge-tts` package, voice `vi-VN-HoaiMyNeural`/`vi-VN-NamMinhNeural`)
  - Fallback: **gTTS** (Google Translate, không cần API key)
- **fluent-ffmpeg** + **ffmpeg-static v6** (KHÔNG dùng system ffmpeg v7 — xem Gotcha)
- **axios + cheerio** (crawl báo VN)
- **Tailwind CSS** dark theme

## 3. Quick start

```bash
# 1. Cài Ollama + model
brew install ollama && ollama serve &
ollama pull llama3.1:latest

# 2. Cài deps
npm install

# 3. Env
cp .env.local.example .env.local      # điền YOUTUBE/TIKTOK keys nếu cần upload

# 4. Chạy
npm run dev                             # http://localhost:3000
```

Test nhanh: paste link `https://thanhnien.vn/...` → chọn voice → Generate → đợi ~1-2 phút.

## 4. Pipeline flow

`POST /api/generate` kick `processPipeline()` async, client poll `GET /api/status/<jobId>` mỗi 800ms.

| Step | File | Hàm chính |
|---|---|---|
| `crawling` | [src/lib/crawler.ts](src/lib/crawler.ts) | `crawlArticle()` + `downloadImages()` + `downloadVideos()` (parallel) |
| `scripting` | [src/lib/script.ts](src/lib/script.ts) | `generateScript()` (Ollama) + `generateHashtags()` (parallel với TTS) |
| `tts` | [src/lib/tts.ts](src/lib/tts.ts) | `sanitizeScript()` → `generateAudio()` → fallback chain Edge → gTTS |
| | [src/lib/video.ts](src/lib/video.ts) | `trimAudioSilence()` cắt silence cuối |
| `subtitles` | [src/lib/subtitle.ts](src/lib/subtitle.ts) | `generateSRT()` + `generateASS()` (chunks ≤ 8 từ) |
| `video` | [src/lib/video.ts](src/lib/video.ts) | `renderVideo()` ffmpeg complex filter |
| `done` | — | `outputs/<jobId>/{video.mp4, audio.mp3, subtitles.srt, job.json}` |

State mỗi job lưu trong [src/lib/jobs.ts](src/lib/jobs.ts) → file JSON `outputs/<id>/job.json`.

## 5. Cấu trúc thư mục

```
src/
├── app/
│   ├── page.tsx                     # UI client (URL input, voice picker, polling, hashtag panel, upload)
│   ├── layout.tsx
│   ├── globals.css
│   └── api/
│       ├── generate/route.ts        # POST: tạo jobId, kick pipeline (fire-and-forget)
│       ├── status/[id]/route.ts     # GET: trả job state cho UI poll
│       ├── download/[id]/[type]/route.ts  # GET: tải mp4/mp3/srt
│       ├── voices/route.ts          # GET: list voice options
│       ├── auth/{youtube,tiktok}/(callback) # OAuth2 flow
│       └── upload/{youtube,tiktok}/ # POST: upload sau khi render xong
└── lib/
    ├── crawler.ts          # axios + cheerio, trích title/content/imageUrls/videoUrls
    ├── script.ts           # Ollama: generateScript() + generateHashtags()
    ├── tts.ts              # Edge TTS WebSocket / gTTS, export sanitizeScript() + VOICES catalog
    ├── subtitle.ts         # SRT + ASS (burn-in subtitle)
    ├── video.ts            # ffmpeg render + trimAudioSilence + downloadVideos + applyAudioSpeed
    ├── jobs.ts             # File-based job store (createJob, updateJob, advanceStep, getJob)
    ├── youtube.ts          # OAuth2 + youtube.videos.insert
    └── tiktok.ts           # OAuth2 + Content Posting API

outputs/<jobId>/            # Per-job artifacts: job.json, audio.mp3, video.mp4, subtitles.{srt,ass}, hero*.img, clip*.mp4
.tokens.json                # YouTube OAuth tokens (gitignored)
.tiktok-token.json          # TikTok OAuth tokens (gitignored)
.tiktok-state               # CSRF state cho TikTok OAuth
```

## 6. Quy tắc code

**Ngôn ngữ comment**: **TIẾNG VIỆT** (toàn bộ codebase đang dùng vậy). Spell-check IDE sẽ báo "Unknown word" cho từ tiếng Việt + tên ffmpeg filter (`zoompan`, `lanczos`, `xfade`, `setpts`, `settb`...) — **bỏ qua**, không phải lỗi.

**Naming**:
- Functions / variables: `camelCase`
- Types / Interfaces: `PascalCase`
- Constants module-scope: `UPPER_SNAKE_CASE`

**Error handling**:
- Throw `Error('thông điệp tiếng Việt')` cho validation/setup
- Pipeline `try-catch` ngoài cùng → `advanceStep(jobId, 'error', { step: 'Lỗi: ' + msg, error: msg })`
- Side-effect tasks (hashtag, trim silence, download image/video) **fail gracefully**: `console.warn` + trả `[]`/`undefined`, KHÔNG chặn pipeline chính

**File organization**:
- `src/lib/*.ts` — pure logic, không Next.js-specific
- `src/app/api/**/route.ts` — chỉ wire HTTP → lib + cập nhật job state
- KHÔNG để business logic trong route handler

**State**: file-based (`outputs/<id>/job.json`) — KHÔNG dùng memory state (Next.js dev mode HMR reload sẽ wipe). Đọc/ghi qua [src/lib/jobs.ts](src/lib/jobs.ts).

**Comments WHY only**: chỉ giải thích lý do non-obvious (workaround, gotcha, ràng buộc). Không comment WHAT — code + tên hàm tự nói.

## 7. Gotchas (rất quan trọng — đã từng debug nhiều giờ)

| # | Gotcha | Workaround |
|---|---|---|
| 1 | `ffmpeg-static` v6 vs system ffmpeg v7 | fluent-ffmpeg parse `-formats` regex 2-cột (D/E). FFmpeg 7 thêm cột device flag (`D d lavfi`) → regex fail → báo "Input format lavfi is not available". [src/lib/video.ts](src/lib/video.ts) **ưu tiên ffmpeg-static (v6)**. Ffprobe vẫn dùng system. |
| 2 | Edge TTS trả về 0 bytes (audio rỗng) | Khi script chứa `**bold**` markdown, MS server fail im lặng, không throw. Phải gọi `sanitizeScript()` từ [src/lib/tts.ts](src/lib/tts.ts) trước khi feed vào TTS. |
| 3 | Edge TTS WebSocket treo 25+ phút | Lib `msedge-tts` không có timeout, có thể giữ connection vô thời hạn. Đã implement: stall timeout 15s + hard timeout 120s + auto-fallback gTTS. |
| 4 | `bufferUtil.mask is not a function` | Webpack bundle `ws` sai khi import từ msedge-tts. Đã thêm `serverComponentsExternalPackages: ['msedge-tts','ws','bufferutil','utf-8-validate','fluent-ffmpeg','ffmpeg-static']` vào [next.config.mjs](next.config.mjs). |
| 5 | ffmpeg xfade timebase mismatch | Sau `concat`/`zoompan`, timebase khác nhau làm xfade fail (`First input link main timebase do not match`). Thêm `settb=AVTB` ở mỗi segment **trước khi xfade**. |
| 6 | zoompan upscale ảnh nhỏ → vỡ | KHÔNG dùng `force_original_aspect_ratio=increase` (cover-fit, upscale ảnh 800px lên 3.2x). Phải dùng `=decrease + pad black` (contain-fit, không upscale). Zoom giới hạn 1.0–1.05. |
| 7 | Regex flag `u` trong TS | tsconfig không set `target` → default ES3, không hỗ trợ `u` flag. Dùng `[^\s#]+` thay vì `\p{L}` Unicode class. |
| 8 | Empty `next.config.mjs` | File có thể bị wipe về 0 byte. Nếu thấy lỗi `bufferUtil.mask` hay tương tự, kiểm tra file này có nội dung không. |

## 8. Env vars

Xem [.env.local.example](.env.local.example) cho danh sách đầy đủ. Cần thiết:

```bash
# LLM
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=llama3.1:latest

# TTS
TTS_PROVIDER=edge                 # 'edge' (auto-fallback gtts khi lỗi) | 'gtts'
EDGE_TTS_VOICE=vi-VN-HoaiMyNeural
TTS_SPEED=0.9                     # 1.0 = chuẩn, 0.9 = chậm 10%

# OAuth (optional, chỉ cần khi muốn upload)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=http://localhost:3000/api/auth/youtube/callback

TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=http://localhost:3000/api/auth/tiktok/callback
```

**Quan trọng**: Đổi `.env.local` hoặc `next.config.mjs` → **phải restart dev server** (Next.js không hot-reload).

## 9. Khi thêm tính năng mới

**Patterns thường gặp**:

- **Thêm step pipeline** → sửa `processPipeline()` trong [src/app/api/generate/route.ts](src/app/api/generate/route.ts), gọi `advanceStep(jobId, '<status>', { step, progress })` trước khi làm việc.
- **Thêm field cho job** → sửa `Job` interface trong [src/lib/jobs.ts](src/lib/jobs.ts), return field đó trong [src/app/api/status/[id]/route.ts](src/app/api/status/%5Bid%5D/route.ts) để UI thấy được.
- **Thêm helper ffmpeg** → đặt trong [src/lib/video.ts](src/lib/video.ts) (đã có `getAudioDuration`, `trimAudioSilence`, `applyAudioSpeed`, `downloadVideo`, `downloadVideos`).
- **UI thêm panel** → thêm component nhỏ phía trên `function Home()` trong [src/app/page.tsx](src/app/page.tsx). Tham khảo `HashtagsPanel`, `UploadPanel`, `PlatformBadge`.
- **Thêm env var** → đọc qua `process.env.X ?? 'default'`, document vào [.env.local.example](.env.local.example).
- **Thêm voice TTS mới** → thêm entry vào `VOICES` array trong [src/lib/tts.ts](src/lib/tts.ts), UI tự pick lên qua `/api/voices`.

## 10. Trước khi commit

- `npx tsc --noEmit` phải sạch
- **KHÔNG** dùng `git add -A` / `git add .` (tránh commit nhầm `.tokens.json`, `.tiktok-token.json`, `.tiktok-state`)
- Test E2E nhanh: tạo 1 job với link báo có ảnh + có video, đảm bảo render thành công
- Restart dev server nếu đổi `.env.local` / `next.config.mjs`

## 11. Test E2E nhanh

1. `npm run dev`
2. Mở http://localhost:3000
3. Paste link (vnexpress.net / thanhnien.vn / dantri.com.vn)
4. Pick voice (Hoài My / Nam Minh / Google)
5. Click Generate, xem step bar + elapsed time
6. Khi xong: preview video, copy hashtag, download mp4
