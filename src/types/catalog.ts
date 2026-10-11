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
};

export type SettingMap = Record<string, string>;
