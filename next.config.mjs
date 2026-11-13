/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep native/external packages out of the bundler (libsql native bindings, ffmpeg binary path resolution)
  serverExternalPackages: ["@libsql/client", "ffmpeg-static"],
  // Make sure the ffmpeg binary ships with the serverless functions that can run merges
  outputFileTracingIncludes: {
    "/api/merge": ["./node_modules/ffmpeg-static/ffmpeg"],
    "/api/mcp": ["./node_modules/ffmpeg-static/ffmpeg"],
    "/api/sse": ["./node_modules/ffmpeg-static/ffmpeg"],
    "/api/messages": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
