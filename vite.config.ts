import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 本地开发需 HTTPS（WebRTC 要求安全上下文），用 mkcert 生成本地证书
// 安装: brew install mkcert && mkcert -install
// 生成: mkcert -key-file .dev-certs/localhost-key.pem -cert-file .dev-certs/localhost.pem localhost
const mkcertKeyPath = path.resolve('.dev-certs/localhost-key.pem');
const mkcertCertPath = path.resolve('.dev-certs/localhost.pem');
const hasLocalCerts = fs.existsSync(mkcertKeyPath) && fs.existsSync(mkcertCertPath);

export default defineConfig({
  plugins: [react()],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    esbuild: {
      drop: ['debugger'],
      pure: ['console.log', 'console.debug', 'console.info'],
    },
  },

  server: {
    port: 1421,
    // localhost 自动视为安全上下文，无需 HTTPS
    // 其他主机名（如局域网 IP）需 mkcert 证书
    https: hasLocalCerts
      ? { key: fs.readFileSync(mkcertKeyPath), cert: fs.readFileSync(mkcertCertPath) }
      : undefined,
    host: false,
  },

  // 相对路径，确保部署到 Cloudflare Pages 后资源正确加载
  base: './',
});
