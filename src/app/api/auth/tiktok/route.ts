import { NextResponse } from 'next/server';
import { getTikTokAuthUrl, isTikTokConnected } from '@/lib/tiktok';

export async function GET() {
  const connected = isTikTokConnected();
  if (connected) {
    return NextResponse.json({ connected: true });
  }
  const authUrl = getTikTokAuthUrl();
  return NextResponse.json({ connected: false, authUrl });
}
