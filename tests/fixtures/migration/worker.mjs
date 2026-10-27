import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

if (process.argv[2] === 'build') {
  const orders = JSON.parse(await readFile('orders.json', 'utf8'));
  const totals = new Map();
  for (const order of orders) {
    const total = totals.get(order.sku) ?? { sku: order.sku, units: 0, revenueCents: 0 };
    total.units += order.quantity;
    total.revenueCents += order.quantity * order.unitCents;
    totals.set(order.sku, total);
  }
  const report = {
    label: process.env.REPORT_LABEL,
    orders: orders.length,
    revenueCents: [...totals.values()].reduce((sum, item) => sum + item.revenueCents, 0),
    items: [...totals.values()].sort((a, b) => a.sku.localeCompare(b.sku)),
  };
  await writeFile('report.json', JSON.stringify(report) + '\n');
  console.log(JSON.stringify(report));
  console.error('report-built');
} else if (process.argv[2] === 'serve') {
  const report = await readFile('report.json');
  createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/report') response.end(report);
    else { response.statusCode = 404; response.end('{"error":"not found"}'); }
  }).listen(3000, '0.0.0.0');
} else {
  console.error('expected build or serve');
  process.exitCode = 7;
}
