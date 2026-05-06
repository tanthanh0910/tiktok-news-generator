import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
const TOKEN_PATH = path.join(process.cwd(), '.tokens.json');

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    process.env.YOUTUBE_REDIRECT_URI
  );
}

export function getYouTubeAuthUrl(): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

export async function exchangeYouTubeCode(code: string): Promise<void> {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

export function isYouTubeConnected(): boolean {
  if (!fs.existsSync(TOKEN_PATH)) return false;
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    return !!tokens.access_token;
  } catch {
    return false;
  }
}

async function getAuthenticatedClient() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('YouTube chưa được kết nối. Vui lòng xác thực trước.');
  }
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
  const client = getOAuthClient();
  client.setCredentials(tokens);

  // Auto-refresh nếu token hết hạn
  client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });

  return client;
}

export interface YouTubeUploadOptions {
  videoPath: string;
  title: string;
  description?: string;
  tags?: string[];
  /** 'public' | 'private' | 'unlisted' */
  privacy?: string;
}

export async function uploadToYouTube(options: YouTubeUploadOptions): Promise<string> {
  const {
    videoPath,
    title,
    description = '',
    tags = [],
    privacy = 'private',
  } = options;

  const auth = await getAuthenticatedClient();
  const youtube = google.youtube({ version: 'v3', auth });

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title.slice(0, 100),
        description,
        tags,
        categoryId: '25', // News & Politics
        defaultLanguage: 'vi',
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(videoPath),
    },
  });

  const videoId = res.data.id;
  if (!videoId) throw new Error('YouTube không trả về video ID');
  return `https://youtube.com/watch?v=${videoId}`;
}
