import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

export interface CrawlResult {
  title: string;
  content: string;
  source: string;
  imageUrl?: string;
}

// Danh sách các domain bị chặn CORS hoặc cần User-Agent đặc biệt
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml',
};

export async function crawlArticle(url: string): Promise<CrawlResult> {
  // Validate URL scheme before fetching
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Chỉ hỗ trợ URL http hoặc https');
  }

  const { data: html } = await axios.get(url, {
    headers: HEADERS,
    timeout: 15_000,
    maxRedirects: 5,
    // Only allow text/html responses
    validateStatus: (s) => s < 400,
  });

  const $ = cheerio.load(html);

  // Remove noise elements
  $('script, style, nav, footer, header, aside, .ads, .advertisement, .social, .comment').remove();

  // Try common Vietnamese news article selectors in priority order
  const contentSelectors = [
    'article .detail-content',
    'article .cms-body',
    '.detail-content',
    '.article-body',
    '.article__body',
    '.content-detail',
    '[itemprop="articleBody"]',
    '.post-content',
    'article',
    'main',
  ];

  let content = '';
  for (const sel of contentSelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 200) {
      content = el.text();
      break;
    }
  }

  // Fallback: grab all <p> tags
  if (!content || content.trim().length < 200) {
    content = $('p')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 50)
      .join('\n\n');
  }

  if (!content || content.trim().length < 100) {
    throw new Error('Không đọc được nội dung bài báo. Trang có thể chặn crawler.');
  }

  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('title').text() ||
    'Bài báo';

  // Lấy ảnh hero theo thứ tự ưu tiên: og:image → twitter:image → ảnh đầu
  // tiên trong article body. Resolve relative URL nếu cần.
  let imageUrl =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[property="og:image:secure_url"]').attr('content') ||
    $('article img').first().attr('src') ||
    $('main img').first().attr('src') ||
    undefined;

  if (imageUrl) {
    try {
      imageUrl = new URL(imageUrl, parsed.origin).toString();
    } catch {
      imageUrl = undefined;
    }
  }

  // Sanitize and limit content length (don't send >8000 chars to OpenAI)
  const sanitized = content
    .replace(/\s+/g, ' ')
    .replace(/[\r\n]+/g, '\n')
    .trim()
    .slice(0, 8000);

  return {
    title: title.trim(),
    content: sanitized,
    source: parsed.hostname,
    imageUrl,
  };
}

/**
 * Tải ảnh về đĩa. Trả về đường dẫn local nếu thành công, undefined nếu fail.
 * Không throw để pipeline luôn chạy tiếp được.
 */
export async function downloadImage(url: string, outputDir: string): Promise<string | undefined> {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      headers: { 'User-Agent': HEADERS['User-Agent'] },
      responseType: 'arraybuffer',
      timeout: 15_000,
      maxContentLength: 20 * 1024 * 1024, // 20MB max
    });

    const contentType = String(res.headers['content-type'] || '').toLowerCase();
    const ext =
      contentType.includes('png') ? 'png'
      : contentType.includes('webp') ? 'webp'
      : contentType.includes('gif') ? 'gif'
      : 'jpg';

    const outputPath = path.join(outputDir, `hero.${ext}`);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(res.data));
    return outputPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[crawler] downloadImage fail:', msg);
    return undefined;
  }
}
