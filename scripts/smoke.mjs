// Post-deploy smoke check (plan §2.2, T-0.0.6): page load, /healthz, one WS
// handshake and one heartbeat. Node ≥22 built-ins only (global fetch + WebSocket).
//
// Usage: node scripts/smoke.mjs <feed-origin> [web-url]
//   node scripts/smoke.mjs http://localhost:8080
//   node scripts/smoke.mjs https://<containerapp-host> https://<swa-host>

const [feedOrigin, webUrl] = process.argv.slice(2);
if (!feedOrigin) {
  console.error('usage: node scripts/smoke.mjs <feed-origin> [web-url]');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

if (webUrl) {
  try {
    const res = await fetch(webUrl);
    const html = await res.text();
    check('web page', res.ok && html.includes('FX Ladder'), `status ${res.status}`);
  } catch (err) {
    check('web page', false, String(err));
  }
}

try {
  const res = await fetch(new URL('/healthz', feedOrigin));
  const body = await res.json();
  check('healthz', res.status === 200 && body.ok === true, JSON.stringify(body));
} catch (err) {
  check('healthz', false, String(err));
}

const wsUrl = new URL('/feed', feedOrigin);
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const heartbeat = await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl, 'fx.v1');
  const timeout = setTimeout(() => {
    resolve({ ok: false, detail: 'no heartbeat within 5 s' });
    ws.close();
  }, 5000);
  ws.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.frameType === 'HEARTBEAT') {
      clearTimeout(timeout);
      resolve({ ok: true, detail: `subprotocol ${ws.protocol}, seq ${frame.firstSeq}` });
      ws.close();
    }
  };
  ws.onerror = () => {
    clearTimeout(timeout);
    resolve({ ok: false, detail: 'handshake failed' });
  };
});
check('ws heartbeat', heartbeat.ok, heartbeat.detail);

process.exit(failures === 0 ? 0 : 1);
