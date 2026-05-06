import fs from 'fs';

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`;
}

/**
 * Chia script thành các cụm (chunks) và gán timestamp dựa trên tỉ lệ từ.
 * Mỗi chunk ≤ 8 từ để hiển thị gọn trên màn hình dọc TikTok.
 */
export function generateSRT(
  script: string,
  audioDurationSec: number,
  outputPath: string
): string {
  // Tách câu theo dấu câu
  const sentences = script
    .split(/(?<=[.!?…])\s+/)
    .flatMap((s) => s.split(/(?<=,)\s+/))  // tách thêm theo dấu phẩy nếu câu quá dài
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const sentence of sentences) {
    const words = sentence.split(' ');
    if (words.length <= 8) {
      chunks.push(sentence);
    } else {
      for (let i = 0; i < words.length; i += 7) {
        const chunk = words.slice(i, i + 7).join(' ');
        chunks.push(chunk);
      }
    }
  }

  const totalWords = script.split(' ').length || 1;
  let srt = '';
  let wordPos = 0;
  let index = 1;

  for (const chunk of chunks) {
    const chunkWords = chunk.split(' ').length;
    const startSec = (wordPos / totalWords) * audioDurationSec;
    const endSec = Math.min(
      ((wordPos + chunkWords) / totalWords) * audioDurationSec,
      audioDurationSec
    );

    srt += `${index}\n`;
    srt += `${formatSRTTime(startSec)} --> ${formatSRTTime(endSec)}\n`;
    srt += `${chunk}\n\n`;

    wordPos += chunkWords;
    index++;
  }

  fs.writeFileSync(outputPath, srt, 'utf-8');
  return srt;
}

/**
 * Tạo ASS subtitle (định dạng hỗ trợ Unicode tốt hơn SRT, dùng cho ffmpeg burn-in).
 * Font size lớn, trắng + outline đen để đọc rõ trên mọi background.
 */
export function generateASS(
  script: string,
  audioDurationSec: number,
  outputPath: string
): void {
  // Tái dùng logic chia chunks từ SRT
  const sentences = script
    .split(/(?<=[.!?…])\s+/)
    .flatMap((s) => s.split(/(?<=,)\s+/))
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const sentence of sentences) {
    const words = sentence.split(' ');
    if (words.length <= 8) {
      chunks.push(sentence);
    } else {
      for (let i = 0; i < words.length; i += 7) {
        chunks.push(words.slice(i, i + 7).join(' '));
      }
    }
  }

  const totalWords = script.split(' ').length || 1;

  function assTime(sec: number) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = (sec % 60).toFixed(2).padStart(5, '0');
    return `${h}:${pad2(m)}:${s}`;
  }

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Unicode MS,52,&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,3,1,2,80,80,160,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let events = '';
  let wordPos = 0;
  for (const chunk of chunks) {
    const chunkWords = chunk.split(' ').length;
    const startSec = (wordPos / totalWords) * audioDurationSec;
    const endSec = Math.min(
      ((wordPos + chunkWords) / totalWords) * audioDurationSec,
      audioDurationSec
    );
    // Escape ASS special chars
    const safeChunk = chunk.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
    events += `Dialogue: 0,${assTime(startSec)},${assTime(endSec)},Default,,0,0,0,,${safeChunk}\n`;
    wordPos += chunkWords;
  }

  fs.writeFileSync(outputPath, header + events, 'utf-8');
}
