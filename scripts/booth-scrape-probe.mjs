// BOOTH 商品信息探针（研究用）。
// 用法: node scripts/booth-scrape-probe.mjs <itemId> [--save]
// 策略: 优先 `booth.pm/{lang}/items/{id}.json`（KonoAsset 同款），
//       失败再用普通页 + Accept: application/json 兜底；两者都不行才回落 HTML 解析。
import fs from "node:fs";
import path from "node:path";
import { parseBoothItem } from "../src/booth-meta.js";

const id = String(process.argv[2] || "").trim();
const save = process.argv.includes("--save");
if (!/^\d{4,10}$/.test(id)) { console.error("usage: node scripts/booth-scrape-probe.mjs <numericItemId> [--save]"); process.exit(2); }
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const H = { "user-agent": UA, accept: "application/json", "accept-language": "zh-CN,zh;q=0.9,ja;q=0.8" };

async function tryJson(lang) {
  const r = await fetch(`https://booth.pm/${lang}/items/${id}.json`, { headers: H, redirect: "follow" });
  if (!r.ok) return null;
  const t = await r.text();
  if (!t.trim().startsWith("{")) return null;
  return { status: r.status, raw: t, json: JSON.parse(t) };
}

let j = await tryJson("ja") || await tryJson("zh-cn");
if (!j) {
  const r = await fetch(`https://booth.pm/zh-cn/items/${id}`, { headers: H });
  const t = await r.text();
  const m = [...t.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((x) => { try { return JSON.parse(x[1]); } catch { return null; } }).filter(Boolean);
  const p = m.find((x) => x && (x["@type"] === "Product" || (Array.isArray(x["@type"]) && x["@type"].includes("Product"))));
  const offer = Array.isArray(p?.offers) ? p.offers[0] : p?.offers;
  console.log(JSON.stringify({ id, status: r.status, source: "html-ldjson", title: p?.name ?? null, shop: p?.brand?.name ?? null, price: offer?.lowPrice ?? offer?.price ?? null, thumbUrl: p?.image ?? null, ageGated: /年齢確認|成人向け|R-?18/i.test(t) }, null, 2));
  process.exit(0);
}
const out = parseBoothItem(j.json);
console.log(JSON.stringify({ ...out, status: j.status }, null, 2));
if (save) {
  const dir = path.join("scripts", "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `booth-item-${id}.json`), j.raw, "utf8");
  console.log(`saved scripts/fixtures/booth-item-${id}.json (${j.raw.length} bytes)`);
}
