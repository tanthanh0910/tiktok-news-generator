import fs from 'fs';
import path from 'path';

const TOKEN_PATH = path.join(process.cwd(), '.tiktok-token.json');

export function getTikTokAuthUrl(): string {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const redirectUri = encodeURIComponent(process.env.TIKTOK_REDIRECT_URI || '');
  // state ngẫu nhiên để chống CSRF
  const state = Math.random().toString(36).slice(2);
  fs.writeFileSync(path.join(process.cwd(), '.tiktok-state'), state);

  return (
    `https://www.tiktok.com/v2/auth/authorize/` +
    `?client_key=${clientKey}` +
    `&scope=video.publish,video.upload` +
    `&response_type=code` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`
  );
}

export async function exchangeTikTokCode(code: string): Promise<void> {
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY || '',
    client_secret: process.env.TIKTOK_CLIENT_SECRET || '',
    code,
    grant_type: 'authorization_code',
    redirect_uri: process.env.TIKTOK_REDIRECT_URI || '',
  });

  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || data.error) {
    throw new Error(`TikTok token error: ${JSON.stringify(data)}`);
  }
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2));
}

export function isTikTokConnected(): boolean {
  if (!fs.existsSync(TOKEN_PATH)) return false;
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    return !!t.access_token;
  } catch {
    return false;
  }
}

async function getAccessToken(): Promise<string> {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('TikTok chưa kết nối. Vui lòng xác thực trước.');
  }
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));

  // Refresh nếu còn refresh_token
  const expiresAt = (token.open_id ? token.expires_in : 0) + (token.timestamp || 0);
  if (Date.now() / 1000 < expiresAt - 60) {
    return token.access_token as string;
  }

  if (!token.refresh_token) throw new Error('TikTok token hết hạn, cần kết nối lại.');

  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY || '',
    client_secret: process.env.TIKTOK_CLIENT_SECRET || '',
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });

  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const newToken = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`TikTok refresh error: ${JSON.stringify(newToken)}`);

  const merged = { ...token, ...newToken, timestamp: Math.floor(Date.now() / 1000) };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  return merged.access_token as string;
}

export interface TikTokUploadOptions {
  videoPath: string;
  title: string;
  description?: string;
}

export async function uploadToTikTok(options: TikTokUploadOptions): Promise<string> {
  const { videoPath, title, description = '' } = options;
  const accessToken = await getAccessToken();

  // Step 1: Init upload – lấy upload_url
  const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: {
        title: (title + ' ' + description).slice(0, 150),
        privacy_level: 'SELF_ONLY', // Đăng dạng private trước để an toàn
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: fs.statSync(videoPath).size,
        chunk_size: fs.statSync(videoPath).size, // Upload 1 chunk
        total_chunk_count: 1,
      },
    }),
  });

  const initData = await initRes.json() as { data?: { publish_id?: string; upload_url?: string }; error?: unknown };
  if (!initRes.ok || !initData.data?.upload_url) {
    throw new Error(`TikTok init upload failed: ${JSON.stringify(initData)}`);
  }

  const { publish_id, upload_url } = initData.data;

  // Step 2: Upload file
  const videoBuffer = fs.readFileSync(videoPath);
  const uploadRes = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
      'Content-Length': String(videoBuffer.length),
    },
    body: videoBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`TikTok upload failed: ${uploadRes.status}`);
  }

  return `https://www.tiktok.com/ (publish_id: ${publish_id})`;
}
