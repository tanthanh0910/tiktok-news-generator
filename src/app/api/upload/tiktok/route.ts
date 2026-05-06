import { NextResponse } from 'next/server';
import { getJob } from '@/lib/jobs';
import { uploadToTikTok } from '@/lib/tiktok';

export async function POST(request: Request) {
  let body: { jobId?: string; title?: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 });
  }

  const { jobId, title = 'TikTok News', description = '' } = body;
  if (!jobId) return NextResponse.json({ error: 'Thiếu jobId' }, { status: 400 });

  const job = getJob(jobId);
  if (!job || !job.videoPath) {
    return NextResponse.json({ error: 'Video chưa sẵn sàng' }, { status: 404 });
  }

  try {
    const result = await uploadToTikTok({
      videoPath: job.videoPath,
      title,
      description,
    });
    return NextResponse.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
