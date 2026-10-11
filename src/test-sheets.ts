import { loadProducts } from "./sheets/products.js";
import { loadSettings } from "./sheets/settings.js";

async function main() {
  console.log("Google Sheets টেস্ট শুরু...");
  const settings = await loadSettings();
  const products = await loadProducts();
  console.log("Settings keys:", Object.keys(settings));
  console.log("Active products:", products.length);
  for (const p of products) {
    console.log(`- ${p.product_id}: ${p.product_name} | ${p.price} BDT | ${p.stock_status}`);
  }
  console.log("Sheets টেস্ট সফল।");
}

main().catch((err) => {
  console.error("Sheets টেস্ট ব্যর্থ:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
