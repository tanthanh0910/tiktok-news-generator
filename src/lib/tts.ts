import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import fs from 'fs';
import path from 'path';
import { applyAudioSpeed } from './video';

const VOICE = process.env.EDGE_TTS_VOICE ?? 'vi-VN-HoaiMyNeural';
const PROVIDER = (process.env.TTS_PROVIDER ?? 'edge').toLowerCase();
// Tốc độ đọc: 1.0 = chuẩn, 0.9 = chậm 10%. Áp dụng cho cả Edge và gTTS.
const SPEECH_RATE = Number(process.env.TTS_SPEED ?? 0.9);
const HARD_TIMEOUT_MS = 120_000;
const STALL_TIMEOUT_MS = 15_000;

/**
 * Loại bỏ markdown labels (**HOOK**:, **NỘI DUNG**:, ...) và markdown markers
 * khỏi script. Dùng cho cả TTS lẫn subtitle để output đồng bộ với voice.
 * Edge TTS sẽ trả về audio rỗng nếu gặp `**bold**` nên buộc phải sanitize.
 */
export function sanitizeScript(input: string): string {
  let s = input;

  // Bỏ nhãn section thường gặp: **HOOK**, [HOOK], (HOOK) – kèm dấu : phía sau
  s = s.replace(/\*?\*?\[?\(?(HOOK|NỘI DUNG|NOI DUNG|GIẢI THÍCH|GIAI THICH|KẾT|KET)\)?\]?\*?\*?\s*[:：]?/gi, '');

  // Bỏ markdown bold/italic markers
  s = s.replace(/\*+/g, '');
  s = s.replace(/_{2,}/g, '');
  s = s.replace(/`+/g, '');

  // Bỏ markdown heading prefix
  s = s.replace(/^#{1,6}\s*/gm, '');

  // Gom whitespace, bỏ dòng trống thừa
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{2,}/g, '\n');
  s = s.trim();

  return s;
}

function escapeSSML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge TTS – chất lượng cao, voice vi-VN-HoaiMyNeural / vi-VN-NamMinhNeural
// Có stall timeout để fail fast khi WebSocket treo (Microsoft đôi lúc giữ
// connection mở mà không gửi data nào).
// ─────────────────────────────────────────────────────────────────────────────
async function generateEdgeTTS(text: string, outputPath: string, voice: string): Promise<void> {
  const tts = new MsEdgeTTS();

  // Bắt mọi unhandledRejection bubble ra từ ws/msedge-tts trong khoảng
  // sống của hàm này (lib có nhiều fire-and-forget promise không catch).
  const rejectionHandler = (err: unknown) => {
    console.error('[edge-tts] unhandledRejection during synth:', err);
  };
  process.on('unhandledRejection', rejectionHandler);

  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  } catch (err) {
    process.off('unhandledRejection', rejectionHandler);
    throw new Error(`Edge TTS setMetadata fail: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { audioStream } = tts.toStream(escapeSSML(text), { rate: SPEECH_RATE });

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let lastChunkAt = Date.now();
    let chunkCount = 0;

    const stallChecker = setInterval(() => {
      if (Date.now() - lastChunkAt > STALL_TIMEOUT_MS) {
        cleanup();
        reject(new Error(
          `Edge TTS treo: không nhận được dữ liệu trong ${STALL_TIMEOUT_MS / 1000}s ` +
          `(đã nhận ${chunkCount} chunks, ${chunks.reduce((s, c) => s + c.length, 0)} bytes)`
        ));
      }
    }, 2_000);

    const hardTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`Edge TTS hard timeout sau ${HARD_TIMEOUT_MS / 1000}s`));
    }, HARD_TIMEOUT_MS);

    function cleanup() {
      clearInterval(stallChecker);
      clearTimeout(hardTimer);
      process.off('unhandledRejection', rejectionHandler);
      audioStream.destroy();
      tts.close();
    }

    audioStream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      chunkCount++;
      lastChunkAt = Date.now();
      if (chunkCount === 1) console.log('[edge-tts] First chunk received');
    });
    audioStream.on('end', () => {
      cleanup();
      console.log(`[edge-tts] Done: ${chunkCount} chunks, ${chunks.reduce((s, c) => s + c.length, 0)} bytes`);
      resolve(Buffer.concat(chunks));
    });
    audioStream.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });

  if (buffer.length === 0) {
    throw new Error('Edge TTS trả về file âm thanh rỗng');
  }

  fs.writeFileSync(outputPath, buffer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Translate TTS (gTTS) – không cần API key, ổn định.
// Giới hạn ~200 ký tự/lần → tự động chunk theo câu rồi nối MP3 buffer.
// Voice: tiếng Việt mặc định, không đổi được giọng.
// ─────────────────────────────────────────────────────────────────────────────
function chunkText(text: string, maxLen = 180): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+/).flatMap((s) => s.split('\n'));
  const out: string[] = [];
  let buf = '';

  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;

    if (s.length > maxLen) {
      flush();
      // Câu dài hơn maxLen → chia theo từ
      const words = s.split(' ');
      for (const w of words) {
        if ((buf + ' ' + w).trim().length > maxLen) { flush(); buf = w; }
        else { buf = buf ? buf + ' ' + w : w; }
      }
      flush();
    } else if ((buf + ' ' + s).trim().length > maxLen) {
      flush();
      buf = s;
    } else {
      buf = buf ? buf + ' ' + s : s;
    }
  }
  flush();
  return out;
}

async function fetchGTTSChunk(text: string, idx: number, total: number): Promise<Buffer> {
  const url =
    `https://translate.google.com/translate_tts?ie=UTF-8` +
    `&q=${encodeURIComponent(text)}` +
    `&tl=vi&total=${total}&idx=${idx}&textlen=${text.length}&client=tw-ob`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Referer': 'https://translate.google.com/',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`gTTS HTTP ${res.status} cho chunk "${text.slice(0, 30)}..."`);
  return Buffer.from(await res.arrayBuffer());
}

async function generateGTTS(text: string, outputPath: string): Promise<void> {
  const chunks = chunkText(text, 180);
  if (chunks.length === 0) throw new Error('Không chunk được text');

  console.log(`[gtts] Tổng ${chunks.length} chunks, đang tải...`);
  const buffers: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const buf = await fetchGTTSChunk(chunks[i], i, chunks.length);
    buffers.push(buf);
    console.log(`[gtts] ${i + 1}/${chunks.length} (${buf.length} bytes)`);
  }

  // Nối MP3 buffer: với MP3 frame-stream concat trực tiếp đa số player chấp nhận.
  fs.writeFileSync(outputPath, Buffer.concat(buffers));

  // gTTS không có rate control như Edge TTS → phải post-process bằng atempo
  if (Math.abs(SPEECH_RATE - 1.0) > 0.001) {
    console.log(`[gtts] Applying speed ${SPEECH_RATE}x...`);
    await applyAudioSpeed(outputPath, SPEECH_RATE);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice catalog (UI dùng list này để render dropdown, server validate id)
// ─────────────────────────────────────────────────────────────────────────────
export interface VoiceOption {
  id: string;
  label: string;
  provider: 'edge' | 'gtts';
  /** Tên voice cho Edge TTS (chỉ áp dụng khi provider='edge') */
  voice?: string;
  gender?: 'female' | 'male';
}

export const VOICES: VoiceOption[] = [
  { id: 'edge-hoaimy', label: 'Nữ - Hoài My', provider: 'edge', voice: 'vi-VN-HoaiMyNeural', gender: 'female' },
  { id: 'edge-namminh', label: 'Nam - Nam Minh', provider: 'edge', voice: 'vi-VN-NamMinhNeural', gender: 'male' },
  { id: 'gtts', label: 'Google (mặc định, ổn định)', provider: 'gtts' },
];

export const DEFAULT_VOICE_ID = VOICES[0].id;

export function findVoice(id: string | undefined): VoiceOption {
  return VOICES.find((v) => v.id === id) ?? VOICES[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export async function generateAudio(
  text: string,
  outputPath: string,
  voiceId?: string
): Promise<void> {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const cleaned = sanitizeScript(text);
  if (!cleaned) throw new Error('Script rỗng sau khi sanitize');

  // voiceId từ UI override env defaults. Không có → dùng env (TTS_PROVIDER + EDGE_TTS_VOICE).
  const selected = voiceId ? findVoice(voiceId) : null;
  const provider = selected?.provider ?? (PROVIDER as 'edge' | 'gtts');
  const edgeVoice = selected?.voice ?? VOICE;

  if (provider === 'gtts') {
    await generateGTTS(cleaned, outputPath);
    return;
  }

  // Edge — fallback sang gTTS nếu treo/lỗi
  try {
    await generateEdgeTTS(cleaned, outputPath, edgeVoice);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tts] Edge TTS thất bại (${msg}), fallback sang gTTS...`);
    await generateGTTS(cleaned, outputPath);
  }
}
