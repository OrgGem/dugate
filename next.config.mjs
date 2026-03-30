/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Tăng body size limit cho upload file lớn (300MB)
  experimental: {
    serverActions: {
      bodySizeLimit: '300mb',
    },
  },
};

export default nextConfig;
