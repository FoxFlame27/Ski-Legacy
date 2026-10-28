// Furniture catalog for chalet build mode.
// Pure data (no imports) so tools/meshy-furniture.mjs can import it too.
//
// size: real-world bounding box in metres [width (x), height (y), depth (z)]. The Meshy GLB
//       is scaled non-uniformly-free (uniform, fit to the largest ratio) to this box.
// place: 'floor' | 'wall' (back faces the wall, mounted at `mount` metres above the floor)
//        | 'ceiling' (hangs from the ceiling).
// flat:  rugs etc. — no collider, may overlap other furniture.
// The model's "front" is +z (Meshy faces the camera = +z).

export const CATEGORIES = [
  { id: 'living', name: 'Living room' },
  { id: 'kitchen', name: 'Kitchen' },
  { id: 'bedroom', name: 'Bedroom' },
  { id: 'bathroom', name: 'Bathroom' },
  { id: 'decor', name: 'Decor' },
  { id: 'lighting', name: 'Lighting' },
];

export const FURNITURE = [
  // Living room
  { id: 'sofa', name: 'Loden Sofa', category: 'living', price: 1200, size: [2.1, 0.85, 0.9], place: 'floor' },
  { id: 'armchair', name: 'Wingback Armchair', category: 'living', price: 450, size: [0.9, 1.0, 0.9], place: 'floor' },
  { id: 'coffee_table', name: 'Oak Coffee Table', category: 'living', price: 220, size: [1.1, 0.45, 0.6], place: 'floor' },
  { id: 'tv_unit', name: 'TV & Stand', category: 'living', price: 1400, size: [1.6, 1.35, 0.45], place: 'floor' },
  { id: 'rug', name: 'Wool Rug', category: 'living', price: 180, size: [2.0, 0.03, 1.4], place: 'floor', flat: true },
  { id: 'bookshelf', name: 'Bookshelf', category: 'living', price: 400, size: [1.0, 2.0, 0.38], place: 'floor' },
  { id: 'fireplace_stove', name: 'Wood Stove', category: 'living', price: 1800, size: [0.8, 1.7, 0.7], place: 'floor' },
  { id: 'log_basket', name: 'Log Basket', category: 'living', price: 60, size: [0.55, 0.45, 0.4], place: 'floor' },

  // Kitchen
  { id: 'kitchen_counter', name: 'Kitchen Counter', category: 'kitchen', price: 650, size: [1.2, 0.92, 0.62], place: 'floor' },
  { id: 'kitchen_sink', name: 'Sink Counter', category: 'kitchen', price: 750, size: [1.2, 0.92, 0.62], place: 'floor' },
  { id: 'fridge', name: 'Fridge', category: 'kitchen', price: 900, size: [0.7, 1.85, 0.7], place: 'floor' },
  { id: 'stove', name: 'Cooker', category: 'kitchen', price: 800, size: [0.62, 0.92, 0.62], place: 'floor' },
  { id: 'dining_table', name: 'Farmhouse Table', category: 'kitchen', price: 600, size: [1.8, 0.76, 0.9], place: 'floor' },
  { id: 'dining_chair', name: 'Carved Chair', category: 'kitchen', price: 120, size: [0.45, 0.95, 0.5], place: 'floor' },
  { id: 'wall_shelf', name: 'Spice Shelf', category: 'kitchen', price: 80, size: [1.0, 0.35, 0.25], place: 'wall', mount: 1.5 },

  // Bedroom
  { id: 'double_bed', name: 'Double Bed', category: 'bedroom', price: 1500, size: [1.7, 1.1, 2.15], place: 'floor' },
  { id: 'single_bed', name: 'Single Bed', category: 'bedroom', price: 700, size: [1.0, 0.95, 2.05], place: 'floor' },
  { id: 'wardrobe', name: 'Painted Wardrobe', category: 'bedroom', price: 850, size: [1.2, 2.1, 0.6], place: 'floor' },
  { id: 'nightstand', name: 'Nightstand', category: 'bedroom', price: 140, size: [0.5, 0.55, 0.4], place: 'floor' },
  { id: 'desk', name: 'Writing Desk', category: 'bedroom', price: 380, size: [1.3, 0.76, 0.65], place: 'floor' },
  { id: 'desk_chair', name: 'Desk Chair', category: 'bedroom', price: 190, size: [0.55, 0.95, 0.55], place: 'floor' },
  { id: 'blanket_chest', name: 'Blanket Chest', category: 'bedroom', price: 300, size: [1.0, 0.55, 0.5], place: 'floor' },

  // Bathroom
  { id: 'bath_rug', name: 'Bath Mat', category: 'bathroom', price: 40, size: [0.9, 0.03, 0.6], place: 'floor', flat: true },
  { id: 'towel_rack', name: 'Towel Ladder', category: 'bathroom', price: 90, size: [0.55, 1.6, 0.35], place: 'floor' },
  { id: 'mirror_cabinet', name: 'Mirror Cabinet', category: 'bathroom', price: 260, size: [0.7, 0.75, 0.18], place: 'wall', mount: 1.2 },
  { id: 'laundry_basket', name: 'Laundry Basket', category: 'bathroom', price: 50, size: [0.45, 0.6, 0.45], place: 'floor' },

  // Decor
  { id: 'plant_tall', name: 'Tall Plant', category: 'decor', price: 80, size: [0.6, 1.3, 0.6], place: 'floor' },
  { id: 'plant_small', name: 'Small Plant', category: 'decor', price: 35, size: [0.35, 0.5, 0.35], place: 'floor' },
  { id: 'ski_rack', name: 'Ski Rack', category: 'decor', price: 220, size: [1.2, 1.6, 0.45], place: 'floor' },
  { id: 'picture_mountain', name: 'Mountain Painting', category: 'decor', price: 150, size: [0.9, 0.65, 0.05], place: 'wall', mount: 1.25 },
  { id: 'picture_deer', name: 'Deer Painting', category: 'decor', price: 150, size: [0.6, 0.8, 0.05], place: 'wall', mount: 1.2 },
  { id: 'antlers', name: 'Antler Trophy', category: 'decor', price: 260, size: [0.7, 0.55, 0.35], place: 'wall', mount: 1.7 },
  { id: 'cuckoo_clock', name: 'Cuckoo Clock', category: 'decor', price: 190, size: [0.35, 0.55, 0.2], place: 'wall', mount: 1.55 },

  // Lighting
  { id: 'floor_lamp', name: 'Floor Lamp', category: 'lighting', price: 160, size: [0.45, 1.65, 0.45], place: 'floor', light: 1.45 },
  { id: 'table_lamp', name: 'Table Lamp', category: 'lighting', price: 70, size: [0.3, 0.5, 0.3], place: 'floor', light: 0.4 },
  { id: 'ceiling_lamp', name: 'Antler Chandelier', category: 'lighting', price: 340, size: [0.9, 0.6, 0.9], place: 'ceiling', light: 0.1 },
  { id: 'wall_sconce', name: 'Wall Sconce', category: 'lighting', price: 90, size: [0.22, 0.32, 0.25], place: 'wall', mount: 1.8, light: 0.2 },
  { id: 'lantern', name: 'Lantern', category: 'lighting', price: 45, size: [0.25, 0.45, 0.25], place: 'floor', light: 0.25 },
];

export const FURNITURE_BY_ID = Object.fromEntries(FURNITURE.map((f) => [f.id, f]));
export const furnitureUrl = (id) => `models/furniture/${id}.glb`;
export const SELL_REFUND = 0.5; // fraction of the price refunded when selling
