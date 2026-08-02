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
// Since v0.1.0 the server opens every wire with a SNAPSHOT and heartbeats
// only through silence (§6.3) — liveness proof is the snapshot itself.
const snapshot = await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl, 'fx.v1');
  const timeout = setTimeout(() => {
    resolve({ ok: false, detail: 'no frame within 5 s' });
    ws.close();
  }, 5000);
  ws.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    clearTimeout(timeout);
    resolve({
      ok: frame.frameType === 'SNAPSHOT' && frame.count > 0,
      detail: `first frame ${frame.frameType}, count ${frame.count}, subprotocol ${ws.protocol}`,
    });
    ws.close();
  };
  ws.onerror = () => {
    clearTimeout(timeout);
    resolve({ ok: false, detail: 'handshake failed' });
  };
});
check('ws snapshot', snapshot.ok, snapshot.detail);

process.exit(failures === 0 ? 0 : 1);
