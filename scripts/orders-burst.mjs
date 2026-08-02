// Dev harness (T-0.3.6): submit a burst of synthetic orders and watch the
// execution mix move in /sim/stats. Node ≥22 built-ins only.
//
// Usage: node scripts/orders-burst.mjs [feed-origin] [count]
//   node scripts/orders-burst.mjs http://localhost:8080 30

const [origin = 'http://localhost:8080', countArg = '20'] = process.argv.slice(2);
const count = Number(countArg);

const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'EURJPY', 'USDTRY'];

async function post(path, body) {
  const res = await fetch(new URL(path, origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function executions() {
  const res = await fetch(new URL('/sim/stats', origin));
  return (await res.json()).executions;
}

console.log(`burst: ${count} orders → ${origin}`);
const before = await executions();

let immediateRejects = 0;
for (let i = 0; i < count; i += 1) {
  const order = {
    pair: PAIRS[i % PAIRS.length],
    side: i % 2 === 0 ? 'buy' : 'sell',
    qtyK: 100 + (i % 9) * 250,
    tif: i % 3 === 0 ? 'IOC' : 'DAY',
  };
  const { status, body } = await post('/sim/order', order);
  if (status !== 200) {
    console.error(`order ${i} refused:`, JSON.stringify(body));
    process.exit(1);
  }
  if (body.immediate.length > 0) immediateRejects += 1;
}
console.log(`submitted ${count}; immediate rejects: ${immediateRejects}; waiting for the scripts to play out…`);

await new Promise((resolve) => setTimeout(resolve, 2500));
const after = await executions();

const delta = (key) => after[key] - before[key];
console.log(
  [
    `submitted +${delta('submitted')}`,
    `trades +${delta('trades')}`,
    `partials +${delta('partials')}`,
    `filled +${delta('filled')}`,
    `canceled +${delta('canceled')}`,
    `rejected +${delta('rejected')}`,
  ].join(' · '),
);
console.log(`last look: hold ${after.lastLook.holdMs} ms, rejectRate ${after.lastLook.rejectRate}`);
