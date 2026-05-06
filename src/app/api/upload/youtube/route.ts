import { NextResponse } from 'next/server';
import { getJob } from '@/lib/jobs';
import { uploadToYouTube } from '@/lib/youtube';

export async function POST(request: Request) {
  let body: { jobId?: string; title?: string; description?: string; privacy?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 });
  }

  const { jobId, title = 'TikTok News', description = '', privacy = 'private' } = body;
  if (!jobId) return NextResponse.json({ error: 'Thiếu jobId' }, { status: 400 });

  const job = getJob(jobId);
  if (!job || !job.videoPath) {
    return NextResponse.json({ error: 'Video chưa sẵn sàng' }, { status: 404 });
  }

  try {
    const videoUrl = await uploadToYouTube({
      videoPath: job.videoPath,
      title,
      description,
      tags: ['tintuc', 'tiktok', 'news', 'viral'],
      privacy,
    });
    return NextResponse.json({ url: videoUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
