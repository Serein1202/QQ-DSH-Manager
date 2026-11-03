// 模拟 DSH web：先分两段打印 token 行（触发跨 chunk 解析），再监听端口
const net = require('net');
const port = Number(process.argv[2]);
const token = 'tok-' + Date.now().toString(36);
process.stdout.write('dsh web: http://127.0.0.1:' + port);
setTimeout(() => {
  process.stdout.write('/?token=' + token + '\n');
  const s = net.createServer(() => {});
  s.listen(port, '127.0.0.1');
}, 120);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
