import { NextResponse } from 'next/server';
import { exchangeYouTubeCode } from '@/lib/youtube';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.redirect(
      new URL(`/?yt_error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code) {
    return NextResponse.json({ error: 'Thiếu code' }, { status: 400 });
  }

  try {
    await exchangeYouTubeCode(code);
    return NextResponse.redirect(new URL('/?yt_connected=1', request.url));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(
      new URL(`/?yt_error=${encodeURIComponent(msg)}`, request.url)
    );
  }
}
