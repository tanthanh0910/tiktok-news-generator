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
