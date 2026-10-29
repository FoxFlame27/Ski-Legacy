// Furniture catalog for chalet build mode.
// Pure data (no imports) so tools/meshy-furniture.mjs can import it too.
//
// size: real-world size in metres [width (x), height (y), depth (z)], relative to the ~1.8 m player.
//       The Meshy GLB is fitted by HEIGHT exactly (flat items: by width); its footprint is then pulled
//       toward width and depth by -23%..+30% per axis (fitScales in placement.js), so proportions stay close
//       to the model's own. Wall items are thinned to the catalog depth.
// place: 'floor' | 'wall' (back faces the wall, mounted at `mount` metres above the floor)
//        | 'ceiling' (hangs from the ceiling).
// light: a lamp: its bulb at this fraction of the height (ceiling: below the top); lux: its PointLight intensity.
//        Placed lamps really light the room (lamps.js) and toggle with E; their on/off is saved as `on`.
// small: little decor that can also stand on a window sill or on top of furniture (tabletop).
// flat:  rugs etc. — no collider, may overlap other furniture.
// seat:  you can sit on it (game/seating.js): { h: seat height (m), n: spots along the front, sides: spots along
//        each long side, facing out (beds) }.
// The model's "front" is +z (Meshy faces the camera = +z).

export const CATEGORIES = [
  { id: 'living', name: 'Living room' },
  { id: 'kitchen', name: 'Kitchen' },
  { id: 'bedroom', name: 'Bedroom' },
  { id: 'bathroom', name: 'Bathroom' },
  { id: 'decor', name: 'Decor' },
  { id: 'lighting', name: 'Lighting' },
];

// prices (Oct 29 rebalance, doubled): little decor $30-100 (a few seconds of work), the big pieces $2,400-3,600;
// one of everything is ~$32,000, so furnishing a chalet is a long, steady spend after the $50,000 purchase
export const FURNITURE = [
  // Living room
  { id: 'sofa', name: 'Loden Sofa', category: 'living', price: 2400, size: [2.1, 0.9, 0.9], place: 'floor', seat: { h: 0.45, n: 3 } },
  { id: 'armchair', name: 'Wingback Armchair', category: 'living', price: 900, size: [0.85, 1.05, 0.9], place: 'floor', seat: { h: 0.45 } },
  { id: 'coffee_table', name: 'Oak Coffee Table', category: 'living', price: 450, size: [1.2, 0.42, 0.7], place: 'floor' },
  { id: 'tv_unit', name: 'TV & Stand', category: 'living', price: 2800, size: [1.6, 1.35, 0.45], place: 'floor' },
  { id: 'rug', name: 'Wool Rug', category: 'living', price: 350, size: [2.0, 0.02, 1.4], place: 'floor', flat: true },
  { id: 'bookshelf', name: 'Bookshelf', category: 'living', price: 800, size: [1.0, 2.0, 0.4], place: 'floor' },
  { id: 'fireplace_stove', name: 'Wood Stove', category: 'living', price: 3600, size: [0.8, 1.9, 0.8], place: 'floor' },
  { id: 'log_basket', name: 'Log Basket', category: 'living', price: 120, size: [0.55, 0.45, 0.45], place: 'floor' },

  // Kitchen
  { id: 'kitchen_counter', name: 'Kitchen Counter', category: 'kitchen', price: 1300, size: [1.0, 0.92, 0.62], place: 'floor' },
  { id: 'kitchen_sink', name: 'Sink Counter', category: 'kitchen', price: 1500, size: [1.2, 1.15, 0.62], place: 'floor' },
  { id: 'fridge', name: 'Fridge', category: 'kitchen', price: 1800, size: [0.75, 1.8, 0.75], place: 'floor' },
  { id: 'stove', name: 'Cooker', category: 'kitchen', price: 1600, size: [0.7, 1.0, 0.65], place: 'floor' },
  { id: 'dining_table', name: 'Farmhouse Table', category: 'kitchen', price: 1200, size: [1.9, 0.75, 0.95], place: 'floor' },
  { id: 'dining_chair', name: 'Carved Chair', category: 'kitchen', price: 250, size: [0.45, 0.95, 0.5], place: 'floor', seat: { h: 0.47 } },
  { id: 'wall_shelf', name: 'Spice Shelf', category: 'kitchen', price: 160, size: [1.0, 0.45, 0.25], place: 'wall', mount: 1.5 },

  // Bedroom
  { id: 'double_bed', name: 'Double Bed', category: 'bedroom', price: 3000, size: [1.6, 1.0, 2.0], place: 'floor', seat: { h: 0.52, sides: 2 } },
  { id: 'single_bed', name: 'Single Bed', category: 'bedroom', price: 1400, size: [1.0, 0.9, 2.0], place: 'floor', seat: { h: 0.5, sides: 2 } },
  { id: 'wardrobe', name: 'Painted Wardrobe', category: 'bedroom', price: 1700, size: [1.2, 2.0, 0.6], place: 'floor' },
  { id: 'nightstand', name: 'Nightstand', category: 'bedroom', price: 300, size: [0.5, 0.6, 0.42], place: 'floor' },
  { id: 'desk', name: 'Writing Desk', category: 'bedroom', price: 750, size: [1.3, 0.76, 0.65], place: 'floor' },
  { id: 'desk_chair', name: 'Desk Chair', category: 'bedroom', price: 400, size: [0.6, 1.0, 0.6], place: 'floor', seat: { h: 0.48 } },
  { id: 'blanket_chest', name: 'Blanket Chest', category: 'bedroom', price: 600, size: [1.0, 0.6, 0.5], place: 'floor', seat: { h: 0.55, n: 2 } },

  // Bathroom
  { id: 'bath_rug', name: 'Bath Mat', category: 'bathroom', price: 80, size: [0.9, 0.02, 0.6], place: 'floor', flat: true },
  { id: 'towel_rack', name: 'Towel Ladder', category: 'bathroom', price: 180, size: [0.5, 1.6, 0.35], place: 'floor' },
  { id: 'mirror_cabinet', name: 'Mirror Cabinet', category: 'bathroom', price: 500, size: [0.65, 0.8, 0.18], place: 'wall', mount: 1.2 },
  { id: 'laundry_basket', name: 'Laundry Basket', category: 'bathroom', price: 100, size: [0.45, 0.6, 0.45], place: 'floor' },

  // Decor
  { id: 'plant_tall', name: 'Tall Plant', category: 'decor', price: 160, size: [0.65, 1.4, 0.65], place: 'floor' },
  { id: 'plant_small', name: 'Small Plant', category: 'decor', price: 70, size: [0.3, 0.5, 0.3], place: 'floor', small: true },
  { id: 'ski_rack', name: 'Ski Rack', category: 'decor', price: 450, size: [1.1, 1.8, 0.55], place: 'floor' },
  { id: 'picture_mountain', name: 'Mountain Painting', category: 'decor', price: 300, size: [0.9, 0.7, 0.05], place: 'wall', mount: 1.25 },
  { id: 'picture_deer', name: 'Deer Painting', category: 'decor', price: 300, size: [0.6, 0.85, 0.05], place: 'wall', mount: 1.2 },
  { id: 'antlers', name: 'Antler Trophy', category: 'decor', price: 500, size: [0.6, 0.7, 0.3], place: 'wall', mount: 1.7 },
  { id: 'cuckoo_clock', name: 'Cuckoo Clock', category: 'decor', price: 400, size: [0.45, 0.85, 0.22], place: 'wall', mount: 1.55 },

  // Small decor: goes on window sills, on top of furniture (tables, counters, shelves...) or the floor
  { id: 'geranium_box', name: 'Geranium Pot', category: 'decor', price: 60, size: [0.4, 0.24, 0.2], place: 'floor', small: true },
  { id: 'herb_pot', name: 'Herb Pot', category: 'decor', price: 40, size: [0.18, 0.24, 0.18], place: 'floor', small: true },
  { id: 'cactus', name: 'Little Cactus', category: 'decor', price: 40, size: [0.2, 0.2, 0.16], place: 'floor', small: true },
  { id: 'vase', name: 'Flower Vase', category: 'decor', price: 50, size: [0.15, 0.32, 0.15], place: 'floor', small: true },
  { id: 'tealight_lantern', name: 'Candle Jar', category: 'decor', price: 30, size: [0.12, 0.18, 0.12], place: 'floor', small: true, light: 0.5, lux: 2 },
  { id: 'deer_figurine', name: 'Carved Deer', category: 'decor', price: 80, size: [0.22, 0.26, 0.1], place: 'floor', small: true },
  { id: 'photo_frame', name: 'Photo Frame', category: 'decor', price: 40, size: [0.2, 0.25, 0.08], place: 'floor', small: true },

  // Lighting
  { id: 'floor_lamp', name: 'Floor Lamp', category: 'lighting', price: 300, size: [0.45, 1.65, 0.45], place: 'floor', light: 0.85, lux: 12 },
  { id: 'table_lamp', name: 'Table Lamp', category: 'lighting', price: 140, size: [0.3, 0.5, 0.3], place: 'floor', light: 0.75, lux: 6, small: true },
  { id: 'ceiling_lamp', name: 'Antler Chandelier', category: 'lighting', price: 700, size: [0.85, 0.65, 0.85], place: 'ceiling', light: 0.6, lux: 16 },
  { id: 'wall_sconce', name: 'Wall Sconce', category: 'lighting', price: 180, size: [0.2, 0.38, 0.22], place: 'wall', mount: 1.8, light: 0.6, lux: 7 },
  { id: 'lantern', name: 'Lantern', category: 'lighting', price: 90, size: [0.22, 0.45, 0.22], place: 'floor', light: 0.5, lux: 4, small: true },
];

export const FURNITURE_BY_ID = Object.fromEntries(FURNITURE.map((f) => [f.id, f]));
export const furnitureUrl = (id) => `models/furniture/${id}.glb`;
export const SELL_REFUND = 0.5; // fraction of the price refunded when selling
