import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { createJob, updateJob, advanceStep, pruneOldJobs } from '@/lib/jobs';
import { crawlArticle, downloadImages } from '@/lib/crawler';
import { generateScript, generateHashtags } from '@/lib/script';
import { generateAudio, sanitizeScript } from '@/lib/tts';
import { generateSRT, generateASS } from '@/lib/subtitle';
import { renderVideo, trimAudioSilence, downloadVideos } from '@/lib/video';

export const maxDuration = 300; // 5 phút cho route này

// Chạy pipeline không đồng bộ (client polling status)
async function processPipeline(jobId: string, url: string, voiceId?: string) {
  const outDir = path.join(process.cwd(), 'outputs', jobId);

  try {
    // Step 1: Crawl + download ảnh & video (song song với các step sau)
    advanceStep(jobId, 'crawling', { step: 'Đang đọc bài báo...', progress: 10 });
    const article = await crawlArticle(url);
    const imageDownload = article.imageUrls.length > 0
      ? downloadImages(article.imageUrls, outDir)
      : Promise.resolve([] as string[]);
    const videoDownload = article.videoUrls.length > 0
      ? downloadVideos(article.videoUrls, outDir)
      : Promise.resolve([] as string[]);

    // Step 2: Generate script. Clean labels (**HOOK**:, ...) ngay sau khi
    // LLM trả về để tất cả các step sau (TTS, subtitle, UI) dùng cùng 1 text.
    advanceStep(jobId, 'scripting', { step: 'Đang viết script TikTok...', progress: 25 });
    const rawScript = await generateScript(article);
    const script = sanitizeScript(rawScript);
    updateJob(jobId, { script });

    // Hashtag generation chạy song song với TTS – cả 2 chỉ cần script.
    // Hashtag fail không chặn pipeline (video vẫn render được, chỉ thiếu hashtag).
    const hashtagsPromise = generateHashtags(article, script).catch((err) => {
      console.warn('[hashtags] generate fail:', err instanceof Error ? err.message : err);
      return [] as string[];
    });

    // Step 3: TTS
    advanceStep(jobId, 'tts', { step: 'Đang tạo giọng đọc...', progress: 45 });
    const audioPath = path.join(outDir, 'audio.mp3');
    await generateAudio(script, audioPath, voiceId);
    // Cắt silence trailing để video kết thúc đúng lúc voice xong.
    // trimAudioSilence trả về duration mới đã chính xác sau khi cắt.
    const duration = await trimAudioSilence(audioPath);
    updateJob(jobId, { audioPath, audioDuration: duration });

    // Step 4: Subtitles (dùng script đã clean để khớp đúng voice)
    advanceStep(jobId, 'subtitles', { step: 'Đang tạo subtitle...', progress: 60 });

    const srtPath = path.join(outDir, 'subtitles.srt');
    const assPath = path.join(outDir, 'subtitles.ass');
    generateSRT(script, duration, srtPath);
    generateASS(script, duration, assPath);
    updateJob(jobId, { srtPath });

    // Step 5: Render video (hard-clamp về đúng duration audio)
    advanceStep(jobId, 'video', { step: 'Đang render video...', progress: 75 });
    const videoPath = path.join(outDir, 'video.mp4');
    const [imagePaths, videoSrcPaths] = await Promise.all([imageDownload, videoDownload]);
    console.log(`[pipeline] Render với ${imagePaths.length} ảnh, ${videoSrcPaths.length} video`);
    await renderVideo({
      audioPath,
      assPath,
      outputPath: videoPath,
      duration,
      imagePaths,
      videoPaths: videoSrcPaths,
    });
    updateJob(jobId, { videoPath });

    // Chờ hashtag generation xong (thường đã xong rồi vì chạy parallel với TTS).
    const hashtags = await hashtagsPromise;
    updateJob(jobId, { hashtags });

    advanceStep(jobId, 'done', { step: 'Hoàn thành!', progress: 100 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline error]', message);
    advanceStep(jobId, 'error', {
      step: 'Lỗi: ' + message,
      error: message,
      progress: 0,
    });
  }
}

export async function POST(request: Request) {
  pruneOldJobs();

  let body: { url?: string; voice?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body JSON không hợp lệ' }, { status: 400 });
  }

  const { url, voice } = body;
  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'Thiếu tham số url' }, { status: 400 });
  }

  // Validate URL
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Invalid protocol');
    }
  } catch {
    return NextResponse.json({ error: 'URL không hợp lệ' }, { status: 400 });
  }

  const jobId = uuidv4();
  createJob(jobId, url);

  // Chạy pipeline bất đồng bộ (fire and forget)
  void processPipeline(jobId, url, typeof voice === 'string' ? voice : undefined);

  return NextResponse.json({ jobId });
}
