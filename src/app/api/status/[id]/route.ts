import { NextResponse } from 'next/server';
import { getJob } from '@/lib/jobs';

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const job = getJob(params.id);
  if (!job) {
    return NextResponse.json({ error: 'Job không tồn tại' }, { status: 404 });
  }

  return NextResponse.json({
    id: job.id,
    status: job.status,
    step: job.step,
    progress: job.progress,
    script: job.script,
    hashtags: job.hashtags,
    audioDuration: job.audioDuration,
    error: job.error,
    createdAt: job.createdAt,
    stepStartedAt: job.stepStartedAt,
    finishedAt: job.finishedAt,
    timings: job.timings,
    // Chỉ thông báo file có tồn tại hay không (không trả path server)
    hasAudio: !!job.audioPath,
    hasSrt: !!job.srtPath,
    hasVideo: !!job.videoPath,
  });
}
