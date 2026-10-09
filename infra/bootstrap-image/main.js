// ALM 자리 이미지: 역할(api·worker·audit-archive·partman)별 최소 동작
const http = require('node:http');
const role = process.argv[2] || process.env.APP_ROLE || 'api';
const log = (msg, extra = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', role, msg, ...extra }));

if (role === 'api') {
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/api/v1/health/live' || path === '/api/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ status: 'ok', build: 'bootstrap' }));
    }
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ code: 'ALM-E503', message: 'ALM API is not deployed yet (bootstrap image)' }));
  });
  server.listen(3000, () => log('listening', { port: 3000 }));
  process.on('SIGTERM', () => { log('shutdown'); server.close(() => process.exit(0)); });
} else if (role === 'worker') {
  log('idle worker (bootstrap)');
  const t = setInterval(() => log('heartbeat'), 300000);
  process.on('SIGTERM', () => { clearInterval(t); log('shutdown'); process.exit(0); });
} else {
  log('nothing to do (bootstrap)');
  process.exit(0);
}
