/**
 * Executable API walkthrough. Run the server first (`npm start`), then:
 *
 *   node scripts/demo.mjs            # against http://localhost:3000
 *   BASE_URL=http://host:port node scripts/demo.mjs
 *
 * Tip: start the server with COUPON_EVERY_N_ORDERS=2 so the coupon part of
 * the demo reaches a milestone quickly.
 */
const base = process.env.BASE_URL ?? "http://localhost:3000";

async function call(method, path, body, note) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  const summary = json?.error
    ? `${json.error.code}: ${json.error.message}`
    : JSON.stringify(json).slice(0, 140) + (JSON.stringify(json).length > 140 ? "…" : "");
  console.log(`${note ? `# ${note}\n` : ""}${method} ${path} -> ${res.status}  ${summary}\n`);
  return { status: res.status, body: json, headers: res.headers };
}

console.log(`Demo against ${base}\n`);
const health = await call("GET", "/health");
if (health.status !== 200) {
  console.error("Server not reachable. Start it with `npm start`.");
  process.exit(1);
}

await call("GET", "/products", undefined, "Catalogue with live prices and stock");

const cart = (await call("POST", "/carts", undefined, "Create a cart")).body;
await call("POST", `/carts/${cart.id}/items`, { productId: "prod-tshirt", quantity: 2 }, "Add 2 t-shirts");
await call("POST", `/carts/${cart.id}/items`, { productId: "prod-tshirt", quantity: 1 }, "Adding again merges -> 3");
await call("POST", `/carts/${cart.id}/items`, { productId: "prod-limited", quantity: 99 }, "Too many of a scarce item -> 409");
await call("POST", `/carts/${cart.id}/items`, { productId: "nope", quantity: 1 }, "Unknown product -> 422");
await call("POST", `/carts/${cart.id}/items`, { productId: "prod-mug", quantity: 0 }, "Invalid quantity -> 400");
await call("PUT", `/carts/${cart.id}/items/prod-tshirt`, { quantity: 1 }, "Set quantity to 1");
await call("GET", `/carts/${cart.id}`, undefined, "View cart");

await call("POST", `/carts/${cart.id}/checkout`, { couponCode: "BOGUS" }, "Unknown coupon -> 422, cart untouched");
const order = await call("POST", `/carts/${cart.id}/checkout`, {}, "Checkout -> 201");
const retry = await call("POST", `/carts/${cart.id}/checkout`, {}, "Retry same request -> 200 replay");
console.log(`   same order? ${retry.body.id === order.body.id}  Idempotent-Replayed: ${retry.headers.get("idempotent-replayed")}\n`);
await call("POST", `/carts/${cart.id}/checkout`, { couponCode: "X" }, "Retry with different terms -> 409");
await call("POST", `/carts/${cart.id}/items`, { productId: "prod-mug", quantity: 1 }, "Mutating a closed cart -> 409");
await call("GET", `/orders/${order.body.id}`, undefined, "Fetch order");

console.log("--- Concurrency: 10 carts race for the 3 remaining limited-edition units ---\n");
const racers = [];
for (let i = 0; i < 10; i++) {
  const c = (await fetch(base + "/carts", { method: "POST" }).then((r) => r.json())).id;
  await fetch(base + `/carts/${c}/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: "prod-limited", quantity: 1 }),
  });
  racers.push(c);
}
const outcomes = await Promise.all(
  racers.map((c) => fetch(base + `/carts/${c}/checkout`, { method: "POST" }).then((r) => r.status)),
);
console.log(`statuses: ${outcomes.join(" ")}`);
console.log(`placed: ${outcomes.filter((s) => s === 201).length}, rejected: ${outcomes.filter((s) => s === 409).length}`);
await call("GET", "/products/prod-limited", undefined, "Inventory after the race");

console.log("--- Coupons ---\n");
let gen = await call("POST", "/admin/coupons", undefined, "Generate coupon (201 if a milestone is unrewarded, else 409)");
if (gen.status === 201) {
  const code = gen.body.coupon.code;
  const c2 = (await call("POST", "/carts")).body;
  await call("POST", `/carts/${c2.id}/items`, { productId: "prod-hoodie", quantity: 1 });
  await call("POST", `/carts/${c2.id}/checkout`, { couponCode: code.toLowerCase() }, "Checkout with coupon (case-insensitive)");
  const c3 = (await call("POST", "/carts")).body;
  await call("POST", `/carts/${c3.id}/items`, { productId: "prod-mug", quantity: 1 });
  await call("POST", `/carts/${c3.id}/checkout`, { couponCode: code }, "Reuse the coupon -> 409");
}
await call("GET", "/admin/coupons", undefined, "Coupons and milestone status");
await call("GET", "/admin/report", undefined, "Report");
