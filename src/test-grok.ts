import { askGrok } from "./ai/grok.js";
import { loadProducts } from "./sheets/products.js";
import { loadSettings } from "./sheets/settings.js";

async function main() {
  console.log("Grok টেস্ট শুরু...");
  const settings = await loadSettings();
  const products = await loadProducts();
  const reply = await askGrok({
    userMessage: "RP-001 প্রোডাক্টের দাম কত? বাংলায় সংক্ষেপে বলো।",
    products,
    settings,
  });
  console.log("Grok উত্তর:");
  console.log(reply);
  console.log("Grok টেস্ট সফল।");
}

main().catch((err) => {
  console.error("Grok টেস্ট ব্যর্থ:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
