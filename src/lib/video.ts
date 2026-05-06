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
 * Render video TikTok dọc (1080×1920) với:
 *  - Gradient background tối (dark blue)
 *  - Thanh accent đỏ trên cùng
 *  - Label "TIN TỨC NÓNG" ở trên
 *  - Subtitle burn-in từ file ASS ở dưới
 *  - Audio từ file MP3
 */
export function renderVideo(params: {
  audioPath: string;
  assPath: string;
  outputPath: string;
  /** Độ dài audio (giây). Dùng để hard-clamp video kết thúc đúng lúc voice xong. */
  duration: number;
  /** Đường dẫn ảnh nền (hero của bài báo). Nếu có sẽ dùng làm background blur + Ken Burns foreground. */
  imagePath?: string;
}): Promise<void> {
  const { audioPath, assPath, outputPath, duration, imagePath } = params;

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Font dir cho filter subtitles (để libass tìm font hỗ trợ tiếng Việt)
  const macFont = '/System/Library/Fonts/Supplemental/Arial Unicode MS.ttf';
  const fallbackFont = '/System/Library/Fonts/Helvetica.ttc';
  const fontDir = path.dirname(fs.existsSync(macFont) ? macFont : fallbackFont);

  const escapePath = (p: string) =>
    p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

  const assEscaped = escapePath(assPath);

  const useImage = !!imagePath && fs.existsSync(imagePath);
  const FPS = 24;
  const totalFrames = Math.max(1, Math.ceil(duration * FPS));

  // ─── Build filter graph ───
  // 2 case: có ảnh hero → blur backdrop + Ken Burns foreground
  //         không có ảnh → gradient navy như cũ
  type Filter = string | { filter: string; options: Record<string, unknown>; inputs: string | string[]; outputs: string };
  const filters: Filter[] = [];

  if (useImage) {
    // Backdrop: scale fit-cover 1080x1920, blur mạnh, tối đi 40%, bão hoà giảm
    filters.push(
      '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.3:saturation=0.6,setsar=1[bg]'
    );
    // Foreground: ảnh gốc fit theo width 1080, zoom chậm Ken Burns 1.0 → 1.15
    // zoompan output là 1080x1080 (vuông), đặt y=420 (dưới label "TIN MOI") để chừa chỗ subtitle
    filters.push(
      `[0:v]scale=2000:-1,zoompan=z='1+0.15*on/${totalFrames}':d=${totalFrames}:s=1080x1080:fps=${FPS},setsar=1[fg]`
    );
    filters.push('[bg][fg]overlay=x=0:y=420[base]');
  } else {
    // Fallback: gradient nếu không có ảnh
    filters.push({
      filter: 'geq',
      options: {
        r: '13+10*(Y/1920)',
        g: '17+22*(Y/1920)',
        b: '23+45*(Y/1920)',
      },
      inputs: '0:v',
      outputs: 'base',
    });
  }

  // Subtitle burn-in (không còn thanh đỏ + label trên header)
  filters.push({
    filter: 'subtitles',
    options: { filename: assEscaped, fontsdir: escapePath(fontDir) },
    inputs: 'base',
    outputs: 'v',
  });

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();

    if (useImage) {
      // Input 0: ảnh hero (loop để thành video stream)
      cmd.input(imagePath!).inputOptions(['-loop', '1', '-framerate', String(FPS)]);
    } else {
      // Input 0: nullsrc (gradient sẽ được tạo bởi geq)
      cmd.input(`nullsrc=s=1080x1920:r=${FPS}`).inputOptions(['-f', 'lavfi']);
    }
    // Input 1: audio
    cmd.input(audioPath);

    cmd
      .complexFilter(filters)
      .outputOptions([
        '-map [v]',
        '-map 1:a',
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 192k',
        // Hard-clamp output về đúng duration audio. Bảo hiểm trường hợp
        // -shortest không cắt được do nullsrc là infinite stream.
        '-t', duration.toFixed(3),
        '-pix_fmt yuv420p',   // Tương thích rộng
        '-movflags +faststart', // Streaming-friendly
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log('[ffmpeg] Start:', cmd))
      .on('progress', (p) => {
        // lavfi nullsrc là infinite input → ffmpeg không tính được percent.
        // Chỉ log khi có giá trị thật để tránh spam "undefined%".
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
