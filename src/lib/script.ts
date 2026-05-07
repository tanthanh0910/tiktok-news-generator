import OpenAI from 'openai';
import type { CrawlResult } from './crawler';

// Dùng OpenAI SDK nhưng trỏ vào Ollama local endpoint
function getClient() {
  return new OpenAI({
    baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
    apiKey: 'ollama', // Ollama không cần key thật nhưng SDK bắt buộc có
  });
}

const MODEL = process.env.OLLAMA_MODEL ?? 'llama3.1:latest';

const SYSTEM_PROMPT = `Bạn là một content creator chuyên làm video TikTok viral về tin tức.

Nhiệm vụ:
- Đọc nội dung tôi cung cấp
- KHÔNG copy nguyên văn
- Viết lại hoàn toàn theo phong cách kể chuyện hấp dẫn

Yêu cầu output (trả về đúng 4 phần, mỗi phần trên 1 dòng mới):
1. [HOOK] 1 câu gây tò mò, gây sốc hoặc kích thích
2. [NỘI DUNG] Tóm tắt 3–5 ý, dễ hiểu, ngắn gọn, nói như đang kể chuyện
3. [GIẢI THÍCH] Giúp người xem hiểu vấn đề, tại sao nó quan trọng
4. [KẾT] 1 câu hỏi hoặc nhận định để tăng tương tác

Quy tắc TUYỆT ĐỐI:
- Tổng dưới 120 từ
- Ngôn ngữ đơn giản, nói như người thật
- Không dùng từ báo chí khô khan
- Không copy câu gốc
- Có thể thêm "bất ngờ", "wow", "điều ít ai biết"
- Tone: nhanh, cuốn, dễ hiểu, phù hợp video 30–60s
- Trả về văn bản thuần tuý, KHÔNG dùng markdown, KHÔNG dùng dấu ngoặc vuông`;

export async function generateScript(article: CrawlResult): Promise<string> {
  const userMessage = `Tiêu đề: ${article.title}\nNguồn: ${article.source}\n\nNội dung bài báo:\n${article.content}`;

  const completion = await getClient().chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.8,
    max_tokens: 500,
  });

  const script = completion.choices[0]?.message?.content?.trim();
  if (!script) throw new Error('Ollama không trả về script');

  return script;
}

const HASHTAG_PROMPT = `Bạn là chuyên gia SEO TikTok tiếng Việt. Sinh hashtag cho video tin tức.

Yêu cầu:
- Đúng 5 hashtag, mỗi hashtag bắt đầu bằng dấu #
- 3 hashtag đầu: chủ đề chính của bài (tên người/địa danh/sự kiện/lĩnh vực)
  + Không có dấu cách trong hashtag (ví dụ: #QuangNgai, không phải #Quang Ngai)
  + Không có dấu trong hashtag (ví dụ: #QuangNgai không phải #QuảngNgãi)
- 2 hashtag cuối: chọn từ danh sách trending - #xuhuong #tintuc #fyp #viral #vietnam
- Tất cả 5 hashtag trên 1 dòng duy nhất, cách nhau bằng dấu cách
- KHÔNG markdown, KHÔNG giải thích, KHÔNG đánh số

Ví dụ output đúng: #QuangNgai #QuyHoach #BatDongSan #xuhuong #tintuc`;

/**
 * Gọi Ollama lần 2 sinh hashtag dựa vào title + content + script.
 * Trả về list 5 hashtag (đã chuẩn hóa, có dấu # phía trước).
 */
export async function generateHashtags(
  article: CrawlResult,
  script: string
): Promise<string[]> {
  const userMessage =
    `Tiêu đề: ${article.title}\n` +
    `Nguồn: ${article.source}\n\n` +
    `Tóm tắt nội dung:\n${article.content.slice(0, 1500)}\n\n` +
    `Script video:\n${script}`;

  const completion = await getClient().chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: HASHTAG_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.5,
    max_tokens: 200,
  });

  const raw = completion.choices[0]?.message?.content?.trim() ?? '';

  // Parse hashtag bằng regex đơn giản. Vietnamese chars vẫn match được vì
  // [^\s#] không loại unicode.
  const matches = raw.match(/#[^\s#]+/g) ?? [];

  // Dedupe + lowercase trending tags để consistency
  const seen = new Set<string>();
  const out: string[] = [];
  const trending = new Set(['#xuhuong', '#tintuc', '#fyp', '#viral', '#vietnam', '#foryou']);
  for (const tag of matches) {
    const normalized = trending.has(tag.toLowerCase()) ? tag.toLowerCase() : tag;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= 5) break;
  }

  return out;
}
