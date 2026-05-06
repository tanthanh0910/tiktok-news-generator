'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
type JobStatus =
  | 'idle'
  | 'queued'
  | 'crawling'
  | 'scripting'
  | 'tts'
  | 'subtitles'
  | 'video'
  | 'done'
  | 'error';

interface StepTiming {
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
}

interface JobState {
  id: string;
  status: JobStatus;
  step: string;
  progress: number;
  script?: string;
  audioDuration?: number;
  error?: string;
  createdAt?: number;
  stepStartedAt?: number;
  finishedAt?: number;
  timings?: StepTiming[];
  hasAudio: boolean;
  hasSrt: boolean;
  hasVideo: boolean;
}

interface Platform {
  connected: boolean | null; // null = loading
  authUrl?: string;
}

// ─────────────────────────────────────────────
// Step indicator
// ─────────────────────────────────────────────
const STEPS: { key: JobStatus; label: string }[] = [
  { key: 'crawling', label: 'Đọc báo' },
  { key: 'scripting', label: 'Viết script' },
  { key: 'tts', label: 'Tạo giọng' },
  { key: 'subtitles', label: 'Subtitle' },
  { key: 'video', label: 'Render video' },
  { key: 'done', label: 'Xong!' },
];

const stepIndex = (s: JobStatus) => STEPS.findIndex((x) => x.key === s);

const STEP_LABEL: Partial<Record<JobStatus, string>> = {
  queued: 'Đang chờ',
  crawling: 'Đọc báo',
  scripting: 'Viết script',
  tts: 'Tạo giọng',
  subtitles: 'Subtitle',
  video: 'Render video',
  done: 'Hoàn thành',
  error: 'Lỗi',
};

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

// Map status → icon label
const STATUS_ICON: Partial<Record<JobStatus, string>> = {
  queued: '⏳',
  crawling: '🔍',
  scripting: '✍️',
  tts: '🎙️',
  subtitles: '📝',
  video: '🎬',
  done: '✅',
  error: '❌',
};

const STATUS_COLOR: Partial<Record<JobStatus, string>> = {
  queued: 'text-yellow-400',
  crawling: 'text-blue-400',
  scripting: 'text-purple-400',
  tts: 'text-green-400',
  subtitles: 'text-cyan-400',
  video: 'text-orange-400',
  done: 'text-green-400',
  error: 'text-red-400',
};

function StepBar({ status }: { status: JobStatus }) {
  // 'queued' → treat as step 0 (highlight Đọc báo as upcoming)
  const current = status === 'queued' ? -0.5 : stepIndex(status);
  return (
    <div className="flex items-center gap-0 w-full mb-6">
      {STEPS.map((step, i) => {
        const done = status !== 'error' && (current > i || status === 'done');
        const active = Math.floor(current) === i || (status === 'queued' && i === 0);
        const isError = status === 'error' && i === Math.max(0, stepIndex('crawling'));
        return (
          <div key={step.key} className="flex items-center flex-1">
            <div className="flex flex-col items-center flex-1">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all
                  ${isError
                    ? 'bg-red-900/40 border-2 border-red-500 text-red-400'
                    : done
                    ? 'bg-[#ff4757] text-white'
                    : active
                    ? 'bg-[#ff4757]/20 border-2 border-[#ff4757] text-[#ff4757] animate-pulse'
                    : 'bg-[#1e1e2e] text-[#6b7280]'}`}
              >
                {done ? '✓' : isError ? '✕' : i + 1}
              </div>
              <span className={`text-[10px] mt-1 text-center leading-tight
                ${done ? 'text-white' : active ? 'text-[#ff4757]' : 'text-[#6b7280]'}`}>
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`h-0.5 flex-1 transition-all ${done ? 'bg-[#ff4757]' : 'bg-[#1e1e2e]'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// Platform connection badge
// ─────────────────────────────────────────────
function PlatformBadge({
  name,
  icon,
  platform,
  onConnect,
}: {
  name: string;
  icon: string;
  platform: Platform;
  onConnect: () => void;
}) {
  if (platform.connected === null) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#1e1e2e] text-[#6b7280] text-sm">
        <span>{icon}</span>
        <span>{name}</span>
        <div className="w-2 h-2 rounded-full bg-[#6b7280] animate-pulse" />
      </div>
    );
  }

  if (platform.connected) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-900/30 border border-green-700/40 text-green-400 text-sm">
        <span>{icon}</span>
        <span>{name}</span>
        <div className="w-2 h-2 rounded-full bg-green-400" />
      </div>
    );
  }

  return (
    <button
      onClick={onConnect}
      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#1e1e2e] border border-[#2e2e3e] text-[#a0a0b0] text-sm hover:border-[#ff4757]/50 hover:text-white transition-all"
    >
      <span>{icon}</span>
      <span>Kết nối {name}</span>
    </button>
  );
}

// ─────────────────────────────────────────────
// Upload panel (shown when video is ready)
// ─────────────────────────────────────────────
function UploadPanel({
  jobId,
  script,
  youtube,
  tiktok,
}: {
  jobId: string;
  script: string;
  youtube: Platform;
  tiktok: Platform;
}) {
  const [title, setTitle] = useState(() => script.split('\n')[0]?.slice(0, 80) || 'Tin tức nóng');
  const [ytStatus, setYtStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [ttStatus, setTtStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [ytUrl, setYtUrl] = useState('');
  const [ytError, setYtError] = useState('');
  const [ttError, setTtError] = useState('');

  const upload = async (platform: 'youtube' | 'tiktok') => {
    const setStatus = platform === 'youtube' ? setYtStatus : setTtStatus;
    const setError = platform === 'youtube' ? setYtError : setTtError;
    setStatus('loading');
    setError('');

    try {
      const res = await fetch(`/api/upload/${platform}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, title }),
      });
      const data = await res.json() as { url?: string; result?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Upload thất bại');
      if (platform === 'youtube' && data.url) setYtUrl(data.url);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
      setStatus('error');
    }
  };

  return (
    <div className="bg-[#111118] border border-[#1e1e2e] rounded-2xl p-6 space-y-4">
      <h3 className="text-white font-semibold text-lg">Đăng lên mạng xã hội</h3>

      <div>
        <label className="text-[#6b7280] text-xs mb-1 block">Tiêu đề video</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={100}
          className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#ff4757]/50"
        />
      </div>

      {/* YouTube */}
      <div className="flex items-center gap-3">
        {youtube.connected ? (
          <button
            onClick={() => upload('youtube')}
            disabled={ytStatus === 'loading' || ytStatus === 'done'}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all
              ${ytStatus === 'done'
                ? 'bg-green-900/30 border border-green-700/40 text-green-400'
                : ytStatus === 'loading'
                ? 'bg-red-900/20 text-[#6b7280] cursor-wait'
                : 'bg-red-600 hover:bg-red-500 text-white'
              }`}
          >
            <span>▶</span>
            {ytStatus === 'loading' ? 'Đang upload...' : ytStatus === 'done' ? 'Đã đăng!' : 'Đăng YouTube'}
          </button>
        ) : (
          <span className="text-[#6b7280] text-sm">YouTube chưa kết nối</span>
        )}
        {ytUrl && (
          <a href={ytUrl} target="_blank" rel="noopener noreferrer" className="text-[#ff4757] text-sm hover:underline">
            Xem video →
          </a>
        )}
        {ytError && <span className="text-red-400 text-xs">{ytError}</span>}
      </div>

      {/* TikTok */}
      <div className="flex items-center gap-3">
        {tiktok.connected ? (
          <button
            onClick={() => upload('tiktok')}
            disabled={ttStatus === 'loading' || ttStatus === 'done'}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all
              ${ttStatus === 'done'
                ? 'bg-green-900/30 border border-green-700/40 text-green-400'
                : ttStatus === 'loading'
                ? 'bg-[#1e1e2e] text-[#6b7280] cursor-wait'
                : 'bg-gradient-to-r from-[#ff0050] to-[#00f2ea] text-white hover:opacity-90'
              }`}
          >
            <span>♪</span>
            {ttStatus === 'loading' ? 'Đang upload...' : ttStatus === 'done' ? 'Đã đăng!' : 'Đăng TikTok'}
          </button>
        ) : (
          <span className="text-[#6b7280] text-sm">TikTok chưa kết nối</span>
        )}
        {ttError && <span className="text-red-400 text-xs">{ttError}</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────
interface VoiceMeta {
  id: string;
  label: string;
  provider: 'edge' | 'gtts';
  gender?: 'female' | 'male';
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [job, setJob] = useState<JobState | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [youtube, setYoutube] = useState<Platform>({ connected: null });
  const [tiktok, setTiktok] = useState<Platform>({ connected: null });
  const [voices, setVoices] = useState<VoiceMeta[]>([]);
  const [voiceId, setVoiceId] = useState<string>('');
  const [now, setNow] = useState(() => Date.now());
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tick mỗi giây để elapsed timer chạy mượt giữa các lần poll.
  useEffect(() => {
    const isRunning = job && job.status !== 'done' && job.status !== 'error';
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job]);

  // ── Check platform connections + fetch voice list on mount ──
  useEffect(() => {
    const init = async () => {
      try {
        const [ytRes, ttRes, voiceRes] = await Promise.all([
          fetch('/api/auth/youtube'),
          fetch('/api/auth/tiktok'),
          fetch('/api/voices'),
        ]);
        const yt = await ytRes.json() as { connected: boolean; authUrl?: string };
        const tt = await ttRes.json() as { connected: boolean; authUrl?: string };
        const vc = await voiceRes.json() as { voices: VoiceMeta[]; defaultVoice: string };
        setYoutube({ connected: yt.connected, authUrl: yt.authUrl });
        setTiktok({ connected: tt.connected, authUrl: tt.authUrl });
        setVoices(vc.voices);
        setVoiceId(vc.defaultVoice);
      } catch {
        setYoutube({ connected: false });
        setTiktok({ connected: false });
      }
    };
    init();
  }, []);

  // ── Handle query params from OAuth callback ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('yt_connected')) {
      setYoutube((p) => ({ ...p, connected: true }));
      window.history.replaceState({}, '', '/');
    }
    if (params.get('tt_connected')) {
      setTiktok((p) => ({ ...p, connected: true }));
      window.history.replaceState({}, '', '/');
    }
    const ytErr = params.get('yt_error');
    const ttErr = params.get('tt_error');
    if (ytErr) alert('YouTube lỗi: ' + ytErr);
    if (ttErr) alert('TikTok lỗi: ' + ttErr);
  }, []);

  // ── Poll job status ──
  const startPolling = useCallback((jobId: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/status/${jobId}`);
        if (!res.ok) return;
        const data = await res.json() as JobState;
        setJob(data);

        if (data.status === 'done' || data.status === 'error') {
          clearInterval(pollingRef.current!);
          pollingRef.current = null;
          setIsGenerating(false);
        }
      } catch {/* ignore network errors during polling */}
    }, 800);
  }, []);

  useEffect(() => () => { if (pollingRef.current) clearInterval(pollingRef.current); }, []);

  // ── Generate ──
  const handleGenerate = async () => {
    if (!url.trim()) return;
    setIsGenerating(true);
    setJob(null);

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), voice: voiceId || undefined }),
      });
      const data = await res.json() as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) throw new Error(data.error || 'Lỗi khởi tạo job');

      setJob({
        id: data.jobId,
        status: 'queued',
        step: 'Đang chờ...',
        progress: 0,
        hasAudio: false,
        hasSrt: false,
        hasVideo: false,
      });

      startPolling(data.jobId);
    } catch (err) {
      setIsGenerating(false);
      alert(err instanceof Error ? err.message : 'Lỗi không xác định');
    }
  };

  const handleConnectPlatform = (platform: 'youtube' | 'tiktok') => {
    const authUrl = platform === 'youtube' ? youtube.authUrl : tiktok.authUrl;
    if (authUrl) window.location.href = authUrl;
  };

  // ─────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      {/* Header */}
      <header className="border-b border-[#1e1e2e] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#ff4757] flex items-center justify-center text-white font-black text-sm">
            TT
          </div>
          <div>
            <h1 className="text-white font-bold text-base leading-none">TikTok News Generator</h1>
            <p className="text-[#6b7280] text-xs mt-0.5">Link báo → Script → Voice → Video → Upload</p>
          </div>
        </div>

        {/* Platform badges */}
        <div className="flex items-center gap-2">
          <PlatformBadge
            name="YouTube"
            icon="▶"
            platform={youtube}
            onConnect={() => handleConnectPlatform('youtube')}
          />
          <PlatformBadge
            name="TikTok"
            icon="♪"
            platform={tiktok}
            onConnect={() => handleConnectPlatform('tiktok')}
          />
        </div>
      </header>

      {/* Main */}
      <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">

        {/* URL Input */}
        <div className="bg-[#111118] border border-[#1e1e2e] rounded-2xl p-6">
          <label className="text-[#6b7280] text-sm mb-3 block">Dán link bài báo</label>
          <div className="flex gap-3">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isGenerating && handleGenerate()}
              placeholder="https://thanhnien.vn/..."
              className="flex-1 bg-[#0a0a0f] border border-[#1e1e2e] rounded-xl px-4 py-3 text-white text-sm placeholder-[#3a3a4a] focus:outline-none focus:border-[#ff4757]/60 transition-colors"
              disabled={isGenerating}
            />
            <button
              onClick={handleGenerate}
              disabled={isGenerating || !url.trim()}
              className={`px-6 py-3 rounded-xl font-semibold text-sm transition-all whitespace-nowrap
                ${isGenerating || !url.trim()
                  ? 'bg-[#1e1e2e] text-[#6b7280] cursor-not-allowed'
                  : 'bg-[#ff4757] hover:bg-[#ff6b7a] text-white shadow-lg shadow-[#ff4757]/20'
                }`}
            >
              {isGenerating ? (
                <span className="flex items-center gap-2">
                  <span className="flex gap-1">
                    <span className="pulse-dot w-1.5 h-1.5 rounded-full bg-current inline-block" />
                    <span className="pulse-dot w-1.5 h-1.5 rounded-full bg-current inline-block" />
                    <span className="pulse-dot w-1.5 h-1.5 rounded-full bg-current inline-block" />
                  </span>
                  Đang xử lý
                </span>
              ) : (
                'Generate ✦'
              )}
            </button>
          </div>

          {/* Voice picker */}
          {voices.length > 0 && (
            <div className="mt-4 flex items-center gap-2 flex-wrap">
              <span className="text-[#6b7280] text-xs">Giọng đọc:</span>
              {voices.map((v) => {
                const selected = v.id === voiceId;
                const icon = v.gender === 'female' ? '👩' : v.gender === 'male' ? '👨' : '🌐';
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setVoiceId(v.id)}
                    disabled={isGenerating}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all
                      ${selected
                        ? 'bg-[#ff4757]/15 border-[#ff4757]/60 text-white'
                        : 'bg-[#0a0a0f] border-[#1e1e2e] text-[#a0a0b0] hover:border-[#ff4757]/30 hover:text-white'
                      }
                      ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <span>{icon}</span>
                    <span>{v.label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Quick example */}
          <p className="text-[#3a3a4a] text-xs mt-3">
            Hỗ trợ: thanhnien.vn, vnexpress.net, tuoitre.vn, dantri.com.vn và hầu hết báo Việt Nam
          </p>
        </div>

        {/* Progress */}
        {job && job.status !== 'idle' && (
          <div className={`bg-[#111118] border rounded-2xl p-6 transition-colors
            ${job.status === 'error' ? 'border-red-800/60' : job.status === 'done' ? 'border-green-800/40' : 'border-[#1e1e2e]'}`}>
            <StepBar status={job.status} />

            {/* Status row */}
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">{STATUS_ICON[job.status] ?? '⏳'}</span>
              <span className={`font-semibold text-sm ${STATUS_COLOR[job.status] ?? 'text-[#6b7280]'}`}>
                {job.step}
              </span>
              {job.stepStartedAt && job.status !== 'done' && job.status !== 'error' && (
                <span className="text-xs text-[#a0a0b0] tabular-nums bg-[#1e1e2e] px-2 py-0.5 rounded-md">
                  ⏱ {formatDuration(now - job.stepStartedAt)}
                </span>
              )}
              {job.status !== 'done' && job.status !== 'error' && (
                <span className="ml-auto text-xs text-[#6b7280] tabular-nums">{job.progress}%</span>
              )}
            </div>

            {/* Progress bar */}
            {job.status !== 'done' && job.status !== 'error' && (
              <div className="w-full bg-[#1e1e2e] rounded-full h-1.5 overflow-hidden">
                <div
                  className={`h-1.5 rounded-full transition-all duration-700
                    ${job.progress === 0 ? 'w-[6%] animate-pulse' : ''} bg-[#ff4757]`}
                  style={job.progress > 0 ? { width: `${job.progress}%` } : {}}
                />
              </div>
            )}

            {/* Timing breakdown */}
            {job.timings && job.timings.length > 0 && (
              <div className="mt-4 pt-4 border-t border-[#1e1e2e] space-y-1.5">
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className="text-[#6b7280]">Chi tiết thời gian</span>
                  {job.createdAt && (
                    <span className="text-[#a0a0b0] tabular-nums">
                      Tổng: {formatDuration((job.finishedAt ?? now) - job.createdAt)}
                    </span>
                  )}
                </div>
                {job.timings
                  .filter((t) => t.status !== 'queued')
                  .map((t, i) => {
                    const end = t.endedAt ?? (job.status === t.status ? now : t.startedAt);
                    const elapsed = end - t.startedAt;
                    const isCurrent = !t.endedAt && job.status === t.status;
                    const isError = t.status === 'error';
                    return (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-2">
                          <span className={
                            isError ? 'text-red-400'
                              : isCurrent ? 'text-[#ff4757]'
                              : t.endedAt ? 'text-green-400'
                              : 'text-[#6b7280]'
                          }>
                            {isError ? '✕' : t.endedAt ? '✓' : isCurrent ? '●' : '○'}
                          </span>
                          <span className={isCurrent ? 'text-white' : 'text-[#a0a0b0]'}>
                            {STEP_LABEL[t.status] ?? t.status}
                          </span>
                        </span>
                        <span className={`tabular-nums ${isCurrent ? 'text-[#ff4757]' : 'text-[#6b7280]'}`}>
                          {formatDuration(elapsed)}
                        </span>
                      </div>
                    );
                  })}
              </div>
            )}

            {/* Error panel */}
            {job.status === 'error' && (
              <div className="mt-2 p-4 bg-red-950/40 border border-red-800/50 rounded-xl space-y-3">
                <div className="flex items-start gap-2">
                  <span className="text-red-400 text-xl leading-none mt-0.5">⚠</span>
                  <div className="flex-1">
                    <p className="text-red-300 font-semibold text-sm mb-1">Đã xảy ra lỗi</p>
                    <p className="text-red-400/80 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
                      {job.error || 'Lỗi không xác định'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => { setJob(null); setIsGenerating(false); }}
                  className="w-full py-2 rounded-lg bg-red-900/30 border border-red-800/40 text-red-300 text-sm hover:bg-red-900/50 transition-colors"
                >
                  Thử lại
                </button>
              </div>
            )}

            {/* Done banner */}
            {job.status === 'done' && (
              <div className="mt-2 p-3 bg-green-950/40 border border-green-800/40 rounded-xl text-green-400 text-sm text-center">
                Hoàn thành! Kéo xuống để tải file và đăng lên MXH.
              </div>
            )}
          </div>
        )}

        {/* Script preview (editable) */}
        {job?.script && (
          <div className="bg-[#111118] border border-[#1e1e2e] rounded-2xl p-6 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-white font-semibold">Script TikTok</h3>
              {job.audioDuration && (
                <span className="text-[#6b7280] text-xs bg-[#1e1e2e] px-2 py-1 rounded-md">
                  ~{job.audioDuration.toFixed(0)}s
                </span>
              )}
            </div>
            <textarea
              defaultValue={job.script}
              rows={8}
              className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-xl px-4 py-3 text-sm text-white leading-relaxed resize-y focus:outline-none focus:border-[#ff4757]/50"
              readOnly
            />
          </div>
        )}

        {/* Download + Video preview */}
        {job?.status === 'done' && (
          <div className="bg-[#111118] border border-[#1e1e2e] rounded-2xl p-6 space-y-4">
            <h3 className="text-white font-semibold">Tải file</h3>

            <div className="grid grid-cols-3 gap-3">
              {[
                { type: 'mp4', label: 'Video .mp4', icon: '🎬', disabled: !job.hasVideo },
                { type: 'mp3', label: 'Audio .mp3', icon: '🎵', disabled: !job.hasAudio },
                { type: 'srt', label: 'Subtitle .srt', icon: '📝', disabled: !job.hasSrt },
              ].map(({ type, label, icon, disabled }) => (
                <a
                  key={type}
                  href={disabled ? '#' : `/api/download/${job.id}/${type}`}
                  onClick={(e) => disabled && e.preventDefault()}
                  className={`flex flex-col items-center gap-2 p-4 rounded-xl border text-sm font-medium transition-all
                    ${disabled
                      ? 'border-[#1e1e2e] text-[#3a3a4a] cursor-not-allowed'
                      : 'border-[#1e1e2e] text-white hover:border-[#ff4757]/50 hover:bg-[#ff4757]/5 cursor-pointer'
                    }`}
                >
                  <span className="text-2xl">{icon}</span>
                  <span>{label}</span>
                </a>
              ))}
            </div>

            {job.hasVideo && (
              <div className="mt-2">
                <p className="text-[#6b7280] text-xs mb-2">Preview video</p>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video
                  src={`/api/download/${job.id}/mp4`}
                  controls
                  className="w-full max-w-[280px] mx-auto rounded-xl border border-[#1e1e2e]"
                  style={{ aspectRatio: '9/16' }}
                />
              </div>
            )}
          </div>
        )}

        {/* Upload panel */}
        {job?.status === 'done' && job.script && (
          <UploadPanel
            jobId={job.id}
            script={job.script}
            youtube={youtube}
            tiktok={tiktok}
          />
        )}

        {/* Setup guide (only when no platforms connected yet) */}
        {!youtube.connected && !tiktok.connected && !job && (
          <details className="bg-[#111118] border border-[#1e1e2e] rounded-2xl">
            <summary className="px-6 py-4 text-[#6b7280] text-sm cursor-pointer hover:text-white transition-colors list-none flex items-center justify-between">
              <span>Hướng dẫn setup API keys</span>
              <span className="text-xs">▼</span>
            </summary>
            <div className="px-6 pb-6 space-y-4 text-sm text-[#a0a0b0]">
              <div>
                <p className="text-white font-medium mb-1">1. OpenAI API Key (bắt buộc)</p>
                <p>Tạo tại <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-[#ff4757] hover:underline">platform.openai.com/api-keys</a></p>
                <p className="mt-1 font-mono text-xs bg-[#0a0a0f] px-3 py-2 rounded-lg mt-1">OPENAI_API_KEY=sk-...</p>
              </div>
              <div>
                <p className="text-white font-medium mb-1">2. YouTube (tuỳ chọn)</p>
                <p>Google Cloud → Enable YouTube Data API v3 → OAuth 2.0 Client</p>
                <p className="mt-1 text-xs text-[#6b7280]">Redirect URI: http://localhost:3000/api/auth/youtube/callback</p>
              </div>
              <div>
                <p className="text-white font-medium mb-1">3. TikTok (tuỳ chọn)</p>
                <p><a href="https://developers.tiktok.com" target="_blank" rel="noopener noreferrer" className="text-[#ff4757] hover:underline">developers.tiktok.com</a> → Tạo app → Request scope: video.publish</p>
                <p className="mt-1 text-xs text-[#6b7280]">Redirect URI: http://localhost:3000/api/auth/tiktok/callback</p>
              </div>
              <p className="text-[#6b7280] text-xs">Sao chép <code className="text-white">.env.local.example</code> → <code className="text-white">.env.local</code> rồi điền key vào.</p>
            </div>
          </details>
        )}
      </main>
    </div>
  );
}
