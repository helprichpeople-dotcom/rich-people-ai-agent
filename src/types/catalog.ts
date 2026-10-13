export type Product = {
  product_id: string;
  product_name: string;
  price: number;
  stock_status: string;
  description: string;
  benefits: string;
  delivery_inside_dhaka: number;
  delivery_outside_dhaka: number;
  product_url: string;
  image_url: string;
  offer: string;
  faq: string;
  active: boolean;
  /** Optional Products column `aliases` (comma separated). */
  aliases?: string[];
  /** Optional negotiation columns (raw strings; validated by pricing/config.ts). */
  pricing?: {
    regular_price: string;
    min_sale_price: string;
    max_sale_price: string;
    negotiation_enabled: string;
    negotiation_mode: string;
    max_discount_amount: string;
    price_step: string;
    pricing_notes: string;
  };
};

export type AdMapping = { ad_id: string; product_id: string; platform: "messenger" | "whatsapp" | "both"; campaign_name: string };

export type SettingMap = Record<string, string>;
