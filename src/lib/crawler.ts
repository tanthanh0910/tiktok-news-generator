import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

export interface CrawlResult {
  title: string;
  content: string;
  source: string;
  imageUrls: string[];
  videoUrls: string[];
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

  // Thu thập ảnh để slideshow: og:image, twitter:image rồi tất cả <img>
  // trong article body / main. Filter http(s), dedupe, limit 8 ảnh đầu.
  const candidates: string[] = [];
  const og = $('meta[property="og:image"]').attr('content');
  const twit = $('meta[name="twitter:image"]').attr('content');
  if (og) candidates.push(og);
  if (twit) candidates.push(twit);

  $('article img, main img, [itemprop="articleBody"] img, .detail-content img, .article-body img, .article__body img')
    .each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original');
      if (src) candidates.push(src);
    });

  const seen = new Set<string>();
  const imageUrls: string[] = [];
  for (const raw of candidates) {
    let abs: string;
    try {
      abs = new URL(raw, parsed.origin).toString();
    } catch {
      continue;
    }
    if (!/^https?:/.test(abs)) continue;
    // Bỏ icon, logo, sprite, base64 (đã loại ở trên), gif động nhỏ
    if (/\b(logo|icon|sprite|avatar|emoji|favicon|placeholder)\b/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    imageUrls.push(abs);
    if (imageUrls.length >= 15) break;
  }

  // Sanitize and limit content length (don't send >8000 chars to LLM)
  const sanitized = content
    .replace(/\s+/g, ' ')
    .replace(/[\r\n]+/g, '\n')
    .trim()
    .slice(0, 8000);

  // Trích video URL: <video src>, <video><source>, og:video, data-src chứa .m3u8.
  // ffmpeg xử lý được cả MP4 trực tiếp lẫn HLS (.m3u8) nên không phân biệt format.
  const videoCandidates: string[] = [];
  const ogVideo =
    $('meta[property="og:video"]').attr('content') ||
    $('meta[property="og:video:url"]').attr('content') ||
    $('meta[property="og:video:secure_url"]').attr('content');
  if (ogVideo) videoCandidates.push(ogVideo);

  $('video, video source').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) videoCandidates.push(src);
  });

  // Một số báo VN nhúng m3u8 vào data-src/data-video-src của thẻ player
  $('[data-src*=".m3u8"], [data-video-src], [data-stream]').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('data-src') || $el.attr('data-video-src') || $el.attr('data-stream');
    if (src) videoCandidates.push(src);
  });

  const videoSeen = new Set<string>();
  const videoUrls: string[] = [];
  for (const raw of videoCandidates) {
    try {
      const abs = new URL(raw, parsed.origin).toString();
      if (!/^https?:/.test(abs)) continue;
      if (!/\.(mp4|m3u8)(\?|$)/i.test(abs)) continue;
      if (videoSeen.has(abs)) continue;
      videoSeen.add(abs);
      videoUrls.push(abs);
      if (videoUrls.length >= 3) break;
    } catch {
      continue;
    }
  }

  return {
    title: title.trim(),
    content: sanitized,
    source: parsed.hostname,
    imageUrls,
    videoUrls,
  };
}

/**
 * Tải 1 ảnh về đĩa. Trả về đường dẫn local nếu thành công, undefined nếu fail.
 */
async function downloadOne(url: string, outputPath: string): Promise<string | undefined> {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      headers: { 'User-Agent': HEADERS['User-Agent'] },
      responseType: 'arraybuffer',
      timeout: 15_000,
      maxContentLength: 20 * 1024 * 1024,
    });
    // Bỏ ảnh quá nhỏ (likely là icon/avatar lọt qua filter)
    if (res.data.byteLength < 10_000) return undefined;
    fs.writeFileSync(outputPath, Buffer.from(res.data));
    return outputPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[crawler] downloadOne fail (${url.slice(0, 60)}...):`, msg);
    return undefined;
  }
}

/**
 * Download song song nhiều ảnh. Trả về list path đã download thành công
 * (giữ thứ tự, bỏ qua ảnh fail). Limit MAX_IMAGES để render không quá lâu.
 */
export async function downloadImages(urls: string[], outputDir: string): Promise<string[]> {
  const MAX_IMAGES = 12;
  const limited = urls.slice(0, MAX_IMAGES);
  fs.mkdirSync(outputDir, { recursive: true });

  // ffmpeg đọc được jpg/png/webp; đặt extension chung là .img để đơn giản
  const results = await Promise.all(
    limited.map((url, i) => downloadOne(url, path.join(outputDir, `hero${i}.img`)))
  );
  return results.filter((p): p is string => !!p);
}
