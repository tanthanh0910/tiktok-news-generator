# TikTok News Generator

Tool tự động: **dán link bài báo → AI viết script → giọng đọc tiếng Việt → render video 1080×1920 → đăng TikTok/YouTube**.

---

## Mục lục

1. [Yêu cầu hệ thống](#1-yêu-cầu-hệ-thống)
2. [Cài đặt](#2-cài-đặt)
3. [Cấu hình env](#3-cấu-hình-env)
4. [Chạy local](#4-chạy-local)
5. [Cách hoạt động (flow)](#5-cách-hoạt-động-flow)
6. [Cấu trúc source](#6-cấu-trúc-source)
7. [Kết nối TikTok & YouTube](#7-kết-nối-tiktok--youtube)
8. [Đổi giọng đọc / model AI](#8-đổi-giọng-đọc--model-ai)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Yêu cầu hệ thống

| Thứ | Phiên bản | Ghi chú |
|-----|-----------|---------|
| Node.js | ≥ 20 | `node -v` |
| npm | ≥ 10 | đi kèm Node |
| ffmpeg | ≥ 7 | `brew install ffmpeg` |
| Ollama | latest | https://ollama.com |
| Model Ollama | `llama3.1:latest` | `ollama pull llama3.1` |

---

## 2. Cài đặt

```bash
# Clone
git clone https://github.com/<your-username>/tiktok-news-generator.git
cd tiktok-news-generator

# Cài packages
npm install

# Cài ffmpeg (macOS)
brew install ffmpeg

# Cài Ollama + pull model
# Tải Ollama tại https://ollama.com rồi:
ollama pull llama3.1
```

---

## 3. Cấu hình env

```bash
cp .env.local.example .env.local
```

Mở `.env.local` và điền:

```env
# ── Bắt buộc ─────────────────────────────────────────────
# Ollama chạy local - không cần key, miễn phí hoàn toàn
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=llama3.1:latest

# Giọng đọc Edge TTS - miễn phí, không cần key
# Nữ: vi-VN-HoaiMyNeural | Nam: vi-VN-NamMinhNeural
EDGE_TTS_VOICE=vi-VN-HoaiMyNeural

# ── Tuỳ chọn (chỉ cần nếu muốn auto-upload) ──────────────
# YouTube OAuth2 - tạo tại console.cloud.google.com
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=http://localhost:3000/api/auth/youtube/callback

# TikTok Content Posting API - tạo tại developers.tiktok.com
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=http://localhost:3000/api/auth/tiktok/callback
```

> `.env.local` đã được `.gitignore` — **không bao giờ commit file này**.

---

## 4. Chạy local

```bash
# Terminal 1: Đảm bảo Ollama đang chạy
ollama serve

# Terminal 2: Chạy web app
npm run dev
```

Mở trình duyệt: **http://localhost:3000**

---

## 5. Cách hoạt động (flow)

```
[User dán link báo]
        │
        ▼
  POST /api/generate
        │  tạo jobId, lưu job.json vào outputs/<jobId>/
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │              Pipeline (async)               │
  │                                             │
  │  1. Crawl       crawler.ts                  │
  │     └─ axios + cheerio đọc HTML bài báo     │
  │        → title + content (tối đa 8000 ký)  │
  │                                             │
  │  2. Script      script.ts                   │
  │     └─ Gửi nội dung vào Ollama local        │
  │        model: llama3.1:latest               │
  │        → script TikTok ≤120 từ             │
  │                                             │
  │  3. TTS         tts.ts                      │
  │     └─ Microsoft Edge TTS (WebSocket)       │
  │        voice: vi-VN-HoaiMyNeural            │
  │        → audio.mp3                          │
  │                                             │
  │  4. Subtitle    subtitle.ts                 │
  │     └─ Chia script thành chunks ≤8 từ       │
  │        Gán timestamp theo tỉ lệ audio       │
  │        → subtitles.srt + subtitles.ass      │
  │                                             │
  │  5. Render      video.ts                    │
  │     └─ ffmpeg: gradient 1080×1920           │
  │        burn-in subtitle ASS                 │
  │        → video.mp4                          │
  └─────────────────────────────────────────────┘
        │
        ▼
  Client polling GET /api/status/<jobId>
  (mỗi 800ms, đọc từ outputs/<jobId>/job.json)
        │
        ▼
  [Download .mp4 / .mp3 / .srt]
  [Hoặc auto-upload TikTok / YouTube]
```

### Tại sao job được lưu vào file thay vì memory?

Next.js dev mode dùng HMR (Hot Module Reload) — mỗi lần save code, module bị reload và biến in-memory bị xoá. Lưu vào `outputs/<jobId>/job.json` thì job tồn tại qua mọi lần reload.

---

## 6. Cấu trúc source

```
src/
├── app/
│   ├── page.tsx                          ← UI chính (React client component)
│   ├── layout.tsx                        ← HTML shell + metadata
│   ├── globals.css                       ← Tailwind + custom styles
│   └── api/
│       ├── generate/route.ts             ← POST: nhận link, khởi chạy pipeline
│       ├── status/[id]/route.ts          ← GET: client poll tiến độ
│       ├── download/[id]/[type]/route.ts ← GET: trả file mp4/mp3/srt
│       ├── auth/
│       │   ├── youtube/route.ts          ← GET: check / lấy OAuth URL
│       │   ├── youtube/callback/route.ts ← GET: nhận code từ Google
│       │   ├── tiktok/route.ts           ← GET: check / lấy OAuth URL
│       │   └── tiktok/callback/route.ts  ← GET: nhận code từ TikTok
│       └── upload/
│           ├── youtube/route.ts          ← POST: upload video lên YouTube
│           └── tiktok/route.ts           ← POST: upload video lên TikTok
│
└── lib/
    ├── jobs.ts       ← CRUD job state (đọc/ghi file JSON)
    ├── crawler.ts    ← Crawl bài báo bằng axios + cheerio
    ├── script.ts     ← Gọi Ollama API tạo script TikTok
    ├── tts.ts        ← Edge TTS → MP3
    ├── subtitle.ts   ← Tạo file .srt và .ass từ script + duration
    ├── video.ts      ← ffmpeg render video 1080×1920
    ├── youtube.ts    ← YouTube OAuth2 + upload API
    └── tiktok.ts     ← TikTok OAuth2 + Content Posting API

outputs/              ← Tự tạo khi chạy, bị gitignore
└── <jobId>/
    ├── job.json      ← Trạng thái job
    ├── audio.mp3
    ├── subtitles.srt
    ├── subtitles.ass
    └── video.mp4
```

---

## 7. Kết nối TikTok & YouTube

### YouTube

1. Vào https://console.cloud.google.com → tạo project
2. Enable **YouTube Data API v3**
3. **Credentials** → OAuth 2.0 Client IDs → Web application
4. Thêm Authorized redirect URI: `http://localhost:3000/api/auth/youtube/callback`
5. Copy **Client ID** và **Client Secret** vào `.env.local`
6. Mở app → click **"Kết nối YouTube"** → đăng nhập Google → xong

Token được lưu vào `.tokens.json` (gitignored). Auto-refresh khi hết hạn.

### TikTok

1. Vào https://developers.tiktok.com → **Developer Portal** → **Manage apps**
2. Tạo app → **Individual**
3. Thêm product **Content Posting API**, scope: `video.publish`, `video.upload`
4. Thêm redirect URI: `http://localhost:3000/api/auth/tiktok/callback`
5. Copy **Client Key** và **Client Secret** vào `.env.local`
6. Mở app → click **"Kết nối TikTok"** → đăng nhập TikTok → xong

> Khi chưa submit review, chỉ đăng được lên **tài khoản của bạn** (sandbox mode). Đủ để dùng cá nhân.

Token lưu tại `.tiktok-token.json` (gitignored). Auto-refresh qua refresh_token.

---

## 8. Đổi giọng đọc / model AI

### Giọng đọc

Đổi trong `.env.local`:

```env
# Giọng nữ (mặc định)
EDGE_TTS_VOICE=vi-VN-HoaiMyNeural

# Giọng nam
EDGE_TTS_VOICE=vi-VN-NamMinhNeural
```

### Model AI

```bash
# Pull model khác
ollama pull qwen2.5:7b   # tiếng Việt tốt hơn, cần ~5GB RAM
```

```env
OLLAMA_MODEL=qwen2.5:7b
```

---

## 9. Troubleshooting

| Lỗi | Nguyên nhân | Fix |
|-----|-------------|-----|
| `404 model not found` | Sai tên model trong env | Chạy `ollama list` → copy tên đúng vào `OLLAMA_MODEL` |
| `bufferUtil.mask is not a function` | webpack bundle ws sai | Thêm `msedge-tts`, `ws` vào `serverComponentsExternalPackages` trong `next.config.mjs` |
| `ffprobe exited with code 1` | ffprobe không tìm thấy | `brew install ffmpeg`, code đã tự dùng system ffmpeg |
| Job 404 khi poll | HMR reload xoá memory | Đã fix: job lưu file, không cần làm gì thêm |
| `429 quota exceeded` | OpenAI hết credit | Đã chuyển sang Ollama miễn phí |
| TTS trả file rỗng | Stream kết thúc sớm | Đã fix: collect chunks vào buffer trước khi ghi |
| Video không có subtitle | Font không tìm thấy | Cài `brew install --cask font-arial` hoặc kiểm tra path font trong `video.ts` |
