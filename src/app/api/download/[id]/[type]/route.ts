import { NextResponse } from 'next/server';
import { getJob } from '@/lib/jobs';
import fs from 'fs';

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  srt: 'text/plain; charset=utf-8',
};

export async function GET(
  _request: Request,
  { params }: { params: { id: string; type: string } }
) {
  const { id, type } = params;

  if (!['mp3', 'mp4', 'srt'].includes(type)) {
    return NextResponse.json({ error: 'Loại file không hợp lệ' }, { status: 400 });
  }

  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: 'Job không tồn tại' }, { status: 404 });
  }

  const fileMap: Record<string, string | undefined> = {
    mp3: job.audioPath,
    mp4: job.videoPath,
    srt: job.srtPath,
  };

  const filePath = fileMap[type];
  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'File chưa sẵn sàng' }, { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);
  return new Response(buffer, {
    headers: {
      'Content-Type': MIME[type],
      'Content-Disposition': `attachment; filename="${id}.${type}"`,
      'Content-Length': String(buffer.length),
    },
  });
}
