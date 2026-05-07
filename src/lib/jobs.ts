// Filesystem-based job store – survives HMR reloads in Next.js dev mode.
// Jobs are stored as JSON files under outputs/<id>/job.json

import fs from 'fs';
import path from 'path';

export type JobStatus =
  | 'queued'
  | 'crawling'
  | 'scripting'
  | 'tts'
  | 'subtitles'
  | 'video'
  | 'done'
  | 'error';

export interface StepTiming {
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  step: string;
  progress: number;
  url: string;
  script?: string;
  hashtags?: string[];
  audioPath?: string;
  srtPath?: string;
  videoPath?: string;
  audioDuration?: number;
  error?: string;
  createdAt: number;
  stepStartedAt: number;
  finishedAt?: number;
  timings: StepTiming[];
}

function jobPath(id: string): string {
  return path.join(process.cwd(), 'outputs', id, 'job.json');
}

export function createJob(id: string, url: string): Job {
  const now = Date.now();
  const job: Job = {
    id,
    status: 'queued',
    step: 'Đang chờ xử lý...',
    progress: 0,
    url,
    createdAt: now,
    stepStartedAt: now,
    timings: [{ status: 'queued', startedAt: now }],
  };
  const dir = path.dirname(jobPath(id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jobPath(id), JSON.stringify(job, null, 2));
  return job;
}

// Chuyển sang step mới: đóng timing step cũ, mở timing step mới.
export function advanceStep(
  id: string,
  status: JobStatus,
  patch: Partial<Job> = {}
): void {
  const job = getJob(id);
  if (!job) return;
  const now = Date.now();
  const timings = [...(job.timings ?? [])];
  const last = timings[timings.length - 1];
  if (last && !last.endedAt) last.endedAt = now;
  // Step terminal (done/error) cũng ghi mốc bắt đầu để biết khi nào kết thúc.
  timings.push({ status, startedAt: now });
  const isTerminal = status === 'done' || status === 'error';
  const updated: Job = {
    ...job,
    ...patch,
    status,
    stepStartedAt: now,
    timings,
    finishedAt: isTerminal ? now : job.finishedAt,
  };
  fs.writeFileSync(jobPath(id), JSON.stringify(updated, null, 2));
}

export function getJob(id: string): Job | undefined {
  // Basic path traversal guard
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  const p = jobPath(id);
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Job;
  } catch {
    return undefined;
  }
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const job = getJob(id);
  if (!job) return;
  const updated = { ...job, ...patch };
  fs.writeFileSync(jobPath(id), JSON.stringify(updated, null, 2));
}

// Remove job folders older than 2 hours
export function pruneOldJobs(): void {
  const outDir = path.join(process.cwd(), 'outputs');
  if (!fs.existsSync(outDir)) return;
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(outDir)) {
    const p = path.join(outDir, entry, 'job.json');
    if (!fs.existsSync(p)) continue;
    try {
      const job = JSON.parse(fs.readFileSync(p, 'utf-8')) as Job;
      if (job.createdAt < cutoff) {
        fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
      }
    } catch { /* skip corrupt entries */ }
  }
}
