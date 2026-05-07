import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// Quan trọng: dùng ffmpeg-static (v6) thay vì system ffmpeg (v7+), vì
// fluent-ffmpeg parse output `-formats` bằng regex 2 cột (D/E). FFmpeg 7
// thêm cột device flag (D d lavfi) → regex fail → fluent-ffmpeg report
// "Input format lavfi is not available" dù binary có hỗ trợ thật.
// ffprobe không bị ảnh hưởng → dùng system ffprobe (ffmpeg-static không
// ship ffprobe).
function resolveFFmpegPath(): string | null {
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  try {
    return execSync('which ffmpeg', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function resolveFFprobePath(): string | null {
  try {
    return execSync('which ffprobe', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

const ffmpegPath = resolveFFmpegPath();
const ffprobePath = resolveFFprobePath();
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);
console.log('[ffmpeg] binary:', ffmpegPath, '| ffprobe:', ffprobePath);

/**
 * Lấy thời lượng (giây) của file audio bằng ffprobe.
 */
export function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, meta) => {
      if (err) return reject(err);
      const duration = meta?.format?.duration;
      if (!duration) return reject(new Error('Không đọc được duration'));
      resolve(duration);
    });
  });
}

/**
 * Render video TikTok dọc (1080×1920):
 *  - 0 ảnh: gradient navy fallback
 *  - 1 ảnh: blur backdrop + Ken Burns foreground (slow zoom in)
 *  - 2+ ảnh: slideshow với 4 motion preset luân phiên + xfade 0.5s giữa các ảnh
 *  - Subtitle burn-in từ file ASS ở dưới
 *  - Audio từ file MP3 hard-clamp về đúng duration
 */
export async function renderVideo(params: {
  audioPath: string;
  assPath: string;
  outputPath: string;
  duration: number;
  /** Đường dẫn ảnh local (đã download). Nếu rỗng → fallback gradient. */
  imagePaths?: string[];
  /** Danh sách video local đã download (mp4). Sẽ ghép theo thứ tự, hard cut. */
  videoPaths?: string[];
}): Promise<void> {
  const { audioPath, assPath, outputPath, duration, imagePaths = [], videoPaths = [] } = params;

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const macFont = '/System/Library/Fonts/Supplemental/Arial Unicode MS.ttf';
  const fallbackFont = '/System/Library/Fonts/Helvetica.ttc';
  const fontDir = path.dirname(fs.existsSync(macFont) ? macFont : fallbackFont);

  const escapePath = (p: string) =>
    p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const assEscaped = escapePath(assPath);

  const validImages = imagePaths.filter((p) => p && fs.existsSync(p));
  const validVideos = videoPaths.filter((p) => p && fs.existsSync(p));
  const FPS = 24;
  const PER = 2.5;
  const XF_DEFAULT = 0.3;

  // Đo duration từng video. Bỏ video không đọc được.
  type VideoClip = { path: string; dur: number };
  const videoClips: VideoClip[] = [];
  for (const p of validVideos) {
    const d = await getAudioDuration(p).catch(() => 0);
    if (d > 0.5) videoClips.push({ path: p, dur: d });
  }

  // Tổng video time available (cap mỗi clip cuối nếu vượt audio).
  // Nếu không đủ AND không có ảnh → loop video list.
  const rawTotalVideo = videoClips.reduce((s, c) => s + c.dur, 0);

  // Build segment list: mỗi segment = { kind: 'video', path, dur } hoặc { kind: 'slideshow' }
  type Segment =
    | { kind: 'video'; path: string; dur: number }
    | { kind: 'slideshow'; dur: number };

  const segments: Segment[] = [];

  if (videoClips.length > 0 && rawTotalVideo >= duration - 0.1) {
    // Video đủ cover hết audio → chỉ dùng video, cut clip cuối nếu vượt.
    let remain = duration;
    for (const c of videoClips) {
      if (remain <= 0.1) break;
      const useDur = Math.min(c.dur, remain);
      segments.push({ kind: 'video', path: c.path, dur: useDur });
      remain -= useDur;
    }
  } else if (videoClips.length > 0 && validImages.length > 0) {
    // Có video + có ảnh: dùng hết video → slideshow phần còn lại
    for (const c of videoClips) {
      segments.push({ kind: 'video', path: c.path, dur: c.dur });
    }
    const slideshowDur = duration - rawTotalVideo + XF_DEFAULT; // +XF cho overlap xfade
    segments.push({ kind: 'slideshow', dur: slideshowDur });
  } else if (videoClips.length > 0) {
    // Chỉ có video, không đủ duration, không có ảnh → loop video list
    let remain = duration;
    let i = 0;
    while (remain > 0.1) {
      const c = videoClips[i % videoClips.length];
      const useDur = Math.min(c.dur, remain);
      segments.push({ kind: 'video', path: c.path, dur: useDur });
      remain -= useDur;
      i++;
    }
  } else if (validImages.length > 0) {
    // Chỉ có ảnh
    segments.push({ kind: 'slideshow', dur: duration });
  }
  // else: gradient fallback (xử lý dưới)

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    const filterParts: string[] = [];
    let inputCount = 0;

    if (segments.length === 0) {
      // ─ Case không có gì: gradient fallback ─
      cmd.input(`nullsrc=s=1080x1920:r=${FPS}`).inputOptions(['-f', 'lavfi']);
      inputCount = 1;
      filterParts.push(
        '[0:v]geq=r=\'13+10*(Y/1920)\':g=\'17+22*(Y/1920)\':b=\'23+45*(Y/1920)\'[base]'
      );
    } else {
      // Mỗi segment → 1 stream output [seg{k}]
      // Hard cut giữa các video, xfade chỉ ở video → slideshow.
      const segOutLabels: string[] = [];

      for (let k = 0; k < segments.length; k++) {
        const seg = segments[k];
        if (seg.kind === 'video') {
          const inIdx = inputCount;
          cmd.input(seg.path);
          inputCount++;
          filterParts.push(
            `[${inIdx}:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,` +
            `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},settb=AVTB,` +
            `trim=duration=${seg.dur.toFixed(3)},setpts=PTS-STARTPTS[seg${k}]`
          );
          segOutLabels.push(`seg${k}`);
        } else {
          // Slideshow segment → build sub-graph với scenes + xfade nội bộ
          const slideshowDur = seg.dur;
          const enoughForSceneXf = slideshowDur > PER + 0.5;
          const XF = enoughForSceneXf ? XF_DEFAULT : 0;
          const nScenes = enoughForSceneXf
            ? Math.max(1, Math.ceil((slideshowDur - XF) / (PER - XF)))
            : 1;
          const PER_FRAMES = Math.max(1, Math.ceil(PER * FPS));
          const SCENE_INPUT_LEN = PER + 0.3;
          const uniqueN = validImages.length;
          const sceneStart = inputCount;

          for (let i = 0; i < nScenes; i++) {
            const imgPath = validImages[i % uniqueN];
            cmd.input(imgPath).inputOptions(['-loop', '1', '-framerate', String(FPS), '-t', SCENE_INPUT_LEN.toFixed(3)]);
            inputCount++;
          }

          for (let i = 0; i < nScenes; i++) {
            const motion = kenBurnsExpr(i, PER_FRAMES, FPS);
            filterParts.push(
              `[${sceneStart + i}:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,` +
              `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,${motion},settb=AVTB,` +
              `trim=duration=${SCENE_INPUT_LEN.toFixed(3)},setpts=PTS-STARTPTS[scn${k}_${i}]`
            );
          }

          if (nScenes === 1) {
            filterParts.push(`[scn${k}_0]copy[seg${k}]`);
          } else {
            let prev = `scn${k}_0`;
            let cumOffset = PER - XF;
            for (let i = 1; i < nScenes; i++) {
              const out = i === nScenes - 1 ? `seg${k}` : `xfk${k}_${i}`;
              filterParts.push(
                `[${prev}][scn${k}_${i}]xfade=transition=fade:duration=${XF}:offset=${cumOffset.toFixed(3)}[${out}]`
              );
              prev = out;
              cumOffset += PER - XF;
            }
          }
          segOutLabels.push(`seg${k}`);
        }
      }

      // Chain segments lại: hard cut giữa video-video, xfade ở video→slideshow
      if (segOutLabels.length === 1) {
        filterParts.push(`[${segOutLabels[0]}]copy[base]`);
      } else {
        let prev = segOutLabels[0];
        let cumOffset = segments[0].dur;
        for (let k = 1; k < segOutLabels.length; k++) {
          const seg = segments[k];
          const prevSeg = segments[k - 1];
          const out = k === segOutLabels.length - 1 ? 'base' : `chain${k}`;
          // Xfade chỉ khi đoạn trước là video VÀ đoạn này là slideshow.
          const useXfade = prevSeg.kind === 'video' && seg.kind === 'slideshow';
          if (useXfade) {
            const offset = Math.max(0, cumOffset - XF_DEFAULT);
            filterParts.push(
              `[${prev}][${segOutLabels[k]}]xfade=transition=fade:duration=${XF_DEFAULT}:offset=${offset.toFixed(3)}[${out}]`
            );
            cumOffset += seg.dur - XF_DEFAULT;
          } else {
            // Hard cut: concat + settb để giữ timebase nhất quán cho xfade tiếp theo
            filterParts.push(
              `[${prev}][${segOutLabels[k]}]concat=n=2:v=1:a=0,settb=AVTB[${out}]`
            );
            cumOffset += seg.dur;
          }
          prev = out;
        }
      }
    }

    // Subtitle burn-in
    filterParts.push(
      `[base]subtitles=filename=${assEscaped}:fontsdir=${escapePath(fontDir)}[v]`
    );

    // Audio input (luôn là input cuối cùng)
    const audioIdx = inputCount;
    cmd.input(audioPath);

    cmd
      .complexFilter(filterParts.join(';'))
      .outputOptions([
        '-map', '[v]',
        '-map', `${audioIdx}:a`,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-t', duration.toFixed(3),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('start', (c) => console.log('[ffmpeg] Start:', c.slice(0, 200) + '...'))
      .on('progress', (p) => {
        if (typeof p.percent === 'number' && !isNaN(p.percent)) {
          console.log(`[ffmpeg] ${p.percent.toFixed(1)}%`);
        }
      })
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`ffmpeg error: ${err.message}`)))
      .run();
  });
}

/**
 * Sinh expression cho zoompan filter — 4 motion preset luân phiên cho slideshow
 * có "góc máy" khác nhau. Zoom nhẹ tối đa 1.05 để không vỡ hình. Output 1080×1920.
 */
function kenBurnsExpr(idx: number, frames: number, fps: number): string {
  const f = frames;
  const Z_MAX = 1.05;
  const Z_MID = 1.03;
  // Centered position cho zoom in/out (input đã được scale fit-cover ≥ 1080×1920)
  const xCenter = `iw/2-(iw/zoom/2)`;
  const yCenter = `ih/2-(ih/zoom/2)`;
  const presets = [
    // Zoom in: 1.0 → 1.05
    `zoompan=z='min(${Z_MAX},1+0.05*on/${f})':x='${xCenter}':y='${yCenter}':d=${f}:s=1080x1920:fps=${fps}`,
    // Zoom out: 1.05 → 1.0
    `zoompan=z='max(1.0,${Z_MAX}-0.05*on/${f})':x='${xCenter}':y='${yCenter}':d=${f}:s=1080x1920:fps=${fps}`,
    // Pan trái → phải với zoom nhẹ
    `zoompan=z=${Z_MID}:x='(iw-iw/zoom)*on/${f}':y='${yCenter}':d=${f}:s=1080x1920:fps=${fps}`,
    // Pan phải → trái với zoom nhẹ
    `zoompan=z=${Z_MID}:x='(iw-iw/zoom)*(1-on/${f})':y='${yCenter}':d=${f}:s=1080x1920:fps=${fps}`,
  ];
  return presets[idx % presets.length];
}

/**
 * Tải video từ URL (mp4 hoặc HLS m3u8) qua ffmpeg. Drop audio gốc, cap thời
 * lượng để không tải quá lớn. Re-encode về h264/yuv420p để filter graph
 * sau dùng được an toàn (m3u8 đôi khi codec lạ không mux được vào mp4).
 * Trả về path nếu OK, undefined nếu fail.
 */
/**
 * Tải nhiều video song song. Trả về list path đã download thành công
 * (giữ thứ tự, bỏ url fail). Mỗi video cap maxDurationSec.
 */
export async function downloadVideos(
  urls: string[],
  outputDir: string,
  maxDurationSec = 90
): Promise<string[]> {
  fs.mkdirSync(outputDir, { recursive: true });
  const results = await Promise.all(
    urls.slice(0, 3).map((url, i) =>
      downloadVideo(url, path.join(outputDir, `clip${i}.mp4`), maxDurationSec)
    )
  );
  return results.filter((p): p is string => !!p);
}

export function downloadVideo(
  url: string,
  outputPath: string,
  maxDurationSec = 90
): Promise<string | undefined> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve) => {
    ffmpeg(url)
      .inputOptions([
        '-user_agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      ])
      .outputOptions([
        '-t', String(maxDurationSec),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '24',
        '-an', // bỏ audio gốc, dùng TTS
        '-pix_fmt', 'yuv420p',
        '-y',
      ])
      .output(outputPath)
      .on('end', () => {
        console.log(`[video-download] OK: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.warn('[video-download] fail:', err.message);
        if (fs.existsSync(outputPath)) {
          try { fs.unlinkSync(outputPath); } catch {/* ignore */}
        }
        resolve(undefined);
      })
      .run();
  });
}

/**
 * Đổi tốc độ phát của audio (atempo). 0.9 = chậm 10%, 1.1 = nhanh 10%.
 * atempo chấp nhận 0.5–2.0; ngoài range cần chain nhiều atempo. Ở đây chỉ
 * dùng 0.85–1.15 nên 1 lần là đủ.
 */
export function applyAudioSpeed(audioPath: string, atempo: number): Promise<void> {
  if (Math.abs(atempo - 1.0) < 0.001) return Promise.resolve();

  const tmpPath = audioPath + '.speed.mp3';
  return new Promise((resolve) => {
    ffmpeg(audioPath)
      .audioFilters(`atempo=${atempo}`)
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .output(tmpPath)
      .on('end', () => {
        try {
          fs.renameSync(tmpPath, audioPath);
          resolve();
        } catch {
          resolve();
        }
      })
      .on('error', (err) => {
        console.warn('[ffmpeg] applyAudioSpeed fail:', err.message);
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        resolve();
      })
      .run();
  });
}

/**
 * Phát hiện vị trí kết thúc của tiếng nói thật trong audio bằng silencedetect.
 * Trả về timestamp (giây) ngay sau từ cuối cùng được phát âm.
 * Nếu không phát hiện được silence cuối, trả về duration tổng.
 */
function detectSpeechEndTime(audioPath: string): Promise<number> {
  return new Promise((resolve) => {
    let lastSilenceStart: number | null = null;
    let totalDuration = 0;

    ffmpeg(audioPath)
      // Silence ngưỡng -35dB, kéo dài ≥0.3s mới tính là silence (giữ pause ngắn giữa câu).
      .audioFilters('silencedetect=noise=-35dB:duration=0.3')
      .format('null')
      .output('/dev/null')
      .on('stderr', (line: string) => {
        // ffmpeg in silence_start qua stderr: "[silencedetect @ ...] silence_start: 28.123"
        const startMatch = line.match(/silence_start:\s*([\d.]+)/);
        if (startMatch) lastSilenceStart = parseFloat(startMatch[1]);
        const durMatch = line.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        if (durMatch) {
          totalDuration =
            parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
        }
      })
      .on('end', () => {
        // Nếu silence_start cuối cùng nằm gần cuối file → cắt tới đó.
        // Còn nếu silence kết thúc trước khi file hết (có nói tiếp sau silence) → giữ nguyên.
        if (lastSilenceStart !== null && totalDuration > 0 && lastSilenceStart < totalDuration) {
          // Buffer thêm 0.15s để không cắt mất hơi thở/đuôi từ cuối
          resolve(Math.min(totalDuration, lastSilenceStart + 0.15));
        } else {
          resolve(totalDuration);
        }
      })
      .on('error', () => resolve(0))
      .run();
  });
}

/**
 * Cắt silence ở đầu/cuối file audio (overwrite tại chỗ). Trả về duration mới.
 * Dùng silencedetect (chính xác hơn silenceremove) để tìm chính xác điểm kết thúc.
 */
export async function trimAudioSilence(audioPath: string): Promise<number> {
  const totalDuration = await getAudioDuration(audioPath).catch(() => 0);
  const speechEnd = await detectSpeechEndTime(audioPath);

  console.log(`[trim] total=${totalDuration.toFixed(2)}s, speechEnd=${speechEnd.toFixed(2)}s`);

  // Nếu silence trailing không đáng kể (<0.2s) thì khỏi re-encode
  if (speechEnd <= 0 || totalDuration - speechEnd < 0.2) {
    return totalDuration;
  }

  const tmpPath = audioPath + '.trim.mp3';
  return new Promise<number>((resolve) => {
    ffmpeg(audioPath)
      // Cắt từ đầu file đến speechEnd (đã bao gồm 0.15s buffer)
      .setStartTime(0)
      .duration(speechEnd)
      // Strip silence ở đầu (nếu có)
      .audioFilters([
        'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-40dB:detection=rms',
      ])
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .output(tmpPath)
      .on('end', async () => {
        try {
          fs.renameSync(tmpPath, audioPath);
          const newDuration = await getAudioDuration(audioPath);
          console.log(`[trim] new duration=${newDuration.toFixed(2)}s`);
          resolve(newDuration);
        } catch {
          resolve(totalDuration);
        }
      })
      .on('error', (err) => {
        console.warn('[ffmpeg] trimAudioSilence fail:', err.message, '— giữ audio gốc');
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        resolve(totalDuration);
      })
      .run();
  });
}
