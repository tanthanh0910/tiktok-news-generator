/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Các package có native binding hoặc dùng dynamic require — webpack
    // không bundle được đúng. Để Node load chúng từ node_modules ở runtime.
    serverComponentsExternalPackages: [
      'msedge-tts',
      'ws',
      'bufferutil',
      'utf-8-validate',
      'fluent-ffmpeg',
      'ffmpeg-static',
    ],
  },
};

export default nextConfig;
