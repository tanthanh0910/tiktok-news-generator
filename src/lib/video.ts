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
export function renderVideo(params: {
  audioPath: string;
  assPath: string;
  outputPath: string;
  duration: number;
  /** Đường dẫn ảnh local (đã download). Nếu rỗng → fallback gradient. */
  imagePaths?: string[];
}): Promise<void> {
  const { audioPath, assPath, outputPath, duration, imagePaths = [] } = params;

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Font dir cho filter subtitles (để libass tìm font hỗ trợ tiếng Việt)
  const macFont = '/System/Library/Fonts/Supplemental/Arial Unicode MS.ttf';
  const fallbackFont = '/System/Library/Fonts/Helvetica.ttc';
  const fontDir = path.dirname(fs.existsSync(macFont) ? macFont : fallbackFont);

  const escapePath = (p: string) =>
    p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const assEscaped = escapePath(assPath);

  const validImages = imagePaths.filter((p) => p && fs.existsSync(p));
  const FPS = 24;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    const filterParts: string[] = [];

    if (validImages.length === 0) {
      // ─ Case 0 ảnh: gradient fallback ─
      cmd.input(`nullsrc=s=1080x1920:r=${FPS}`).inputOptions(['-f', 'lavfi']);
      filterParts.push(
        '[0:v]geq=r=\'13+10*(Y/1920)\':g=\'17+22*(Y/1920)\':b=\'23+45*(Y/1920)\'[base]'
      );
    } else {
      // ─ Case 1+ ảnh: dùng image input(s), build slideshow nếu nhiều hơn 1 ─
      const N = validImages.length;
      const XF = N >= 2 ? 0.5 : 0;
      // Mỗi ảnh chiếm: (duration + XF*(N-1)) / N giây để tổng (sau xfade) đúng = duration
      const PER = (duration + XF * (N - 1)) / N;
      const PER_FRAMES = Math.max(1, Math.ceil(PER * FPS));
      // Thêm chút buffer (+0.3s) cho mỗi input để xfade không bị chạm boundary
      const INPUT_LEN = PER + 0.3;

      // Add inputs
      for (const p of validImages) {
        cmd.input(p).inputOptions(['-loop', '1', '-framerate', String(FPS), '-t', INPUT_LEN.toFixed(3)]);
      }

      // Build per-image scene (backdrop blur + foreground Ken Burns overlay)
      for (let i = 0; i < N; i++) {
        // Backdrop: blur fit-cover full 1080x1920
        filterParts.push(
          `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.3:saturation=0.6,setsar=1,trim=duration=${INPUT_LEN.toFixed(3)},setpts=PTS-STARTPTS[bg${i}]`
        );

        // Foreground: 1 trong 4 motion preset (luân phiên theo i)
        const motion = kenBurnsExpr(i, PER_FRAMES, FPS);
        filterParts.push(
          `[${i}:v]scale=2000:-1,${motion},setsar=1,trim=duration=${INPUT_LEN.toFixed(3)},setpts=PTS-STARTPTS[fg${i}]`
        );

        // Compose: backdrop + foreground
        filterParts.push(`[bg${i}][fg${i}]overlay=x=0:y=420[scene${i}]`);
      }

      if (N === 1) {
        filterParts.push(`[scene0]copy[base]`);
      } else {
        // Chain xfade transitions
        let prev = 'scene0';
        let cumOffset = PER - XF;
        for (let i = 1; i < N; i++) {
          const out = i === N - 1 ? 'base' : `xf${i}`;
          filterParts.push(
            `[${prev}][scene${i}]xfade=transition=fade:duration=${XF}:offset=${cumOffset.toFixed(3)}[${out}]`
          );
          prev = out;
          cumOffset += PER - XF;
        }
      }
    }

    // Subtitle burn-in
    filterParts.push(
      `[base]subtitles=filename=${assEscaped}:fontsdir=${escapePath(fontDir)}[v]`
    );

    // Audio input (luôn là input cuối cùng)
    const audioIdx = validImages.length === 0 ? 1 : validImages.length;
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
 * Sinh expression cho zoompan filter — luân phiên 4 kiểu motion theo index để
 * mỗi ảnh có "góc máy" khác nhau. Output luôn là 1080x1080 ở FPS đã cho.
 */
function kenBurnsExpr(idx: number, frames: number, fps: number): string {
  const f = frames;
  const presets = [
    // Zoom in chậm: 1.0 → 1.25
    `zoompan=z='min(1.25,1+0.25*on/${f})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${f}:s=1080x1080:fps=${fps}`,
    // Zoom out: 1.25 → 1.0
    `zoompan=z='max(1.0,1.25-0.25*on/${f})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${f}:s=1080x1080:fps=${fps}`,
    // Pan trái → phải, zoom nhẹ 1.15
    `zoompan=z=1.15:x='iw*0.15+iw*0.15*on/${f} - (iw/zoom/2)*0+iw*0.15*on/${f}':y='ih/2-(ih/zoom/2)':d=${f}:s=1080x1080:fps=${fps}`,
    // Pan phải → trái, zoom nhẹ 1.15
    `zoompan=z=1.15:x='iw*0.45-iw*0.15*on/${f}':y='ih/2-(ih/zoom/2)':d=${f}:s=1080x1080:fps=${fps}`,
  ];
  return presets[idx % presets.length];
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
