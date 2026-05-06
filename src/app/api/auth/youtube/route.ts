import { NextResponse } from 'next/server';
import { getYouTubeAuthUrl, isYouTubeConnected } from '@/lib/youtube';

export async function GET() {
  const connected = isYouTubeConnected();
  if (connected) {
    return NextResponse.json({ connected: true });
  }
  const authUrl = getYouTubeAuthUrl();
  return NextResponse.json({ connected: false, authUrl });
}
