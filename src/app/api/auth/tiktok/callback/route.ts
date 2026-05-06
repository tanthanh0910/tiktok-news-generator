import { NextResponse } from 'next/server';
import { exchangeTikTokCode } from '@/lib/tiktok';
import fs from 'fs';
import path from 'path';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.redirect(
      new URL(`/?tt_error=${encodeURIComponent(error)}`, request.url)
    );
  }

  // Verify CSRF state
  const statePath = path.join(process.cwd(), '.tiktok-state');
  const savedState = fs.existsSync(statePath)
    ? fs.readFileSync(statePath, 'utf-8').trim()
    : null;

  if (!savedState || state !== savedState) {
    return NextResponse.json({ error: 'Invalid state (CSRF)' }, { status: 400 });
  }
  fs.unlinkSync(statePath); // Dùng 1 lần rồi xoá

  if (!code) {
    return NextResponse.json({ error: 'Thiếu code' }, { status: 400 });
  }

  try {
    await exchangeTikTokCode(code);
    return NextResponse.redirect(new URL('/?tt_connected=1', request.url));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(
      new URL(`/?tt_error=${encodeURIComponent(msg)}`, request.url)
    );
  }
}
