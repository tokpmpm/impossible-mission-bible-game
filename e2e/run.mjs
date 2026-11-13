// 啟動伺服器，依序跑 3／6／10 人的瀏覽器端對端（需要預裝的 Playwright）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = process.env.PORT || '3100';
const server = spawn(process.execPath, ['src/server/main.ts'], { cwd: root, env: { ...process.env, PORT }, stdio: 'ignore' });
const run = (env) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, ['e2e/play.cjs'], { cwd: root, env: { ...process.env, PORT, ...env }, stdio: 'inherit' });
    c.on('exit', (code) => resolve(code ?? 1));
  });
let failed = 0;
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const [N, W] of [['3', '390'], ['6', '360'], ['10', '320']]) failed += (await run({ N, W, TAG: `n${N}-` })) ? 1 : 0;
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
