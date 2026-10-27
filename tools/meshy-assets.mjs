// Asset manifest for Meshy generation. Characters are generated in T-pose and rigged.
export const ASSETS = [
  {
    name: 'skier_red',
    rig: true,
    pose: 'a-pose',
    polycount: 30000,
    prompt: 'Full body 3D game character of an adult male skier standing in a neutral A-pose: both arms hanging straight down and angled 45 degrees away from the body, elbows straight, hands open and relaxed with fingers together, legs straight and slightly apart, looking forward. Wearing a fitted red and white ski jacket, black ski pants, black ski helmet with orange goggles resting on the helmet, black gloves, red ski boots. Realistic proportions, photorealistic',
    texture: 'photorealistic red and white ski jacket with zippers and seams, black ski pants, black matte helmet, orange mirror goggles, black gloves, glossy red ski boots, realistic face',
  },
  {
    name: 'skier_blue',
    rig: true,
    pose: 'a-pose',
    polycount: 30000,
    prompt: 'Full body 3D game character of an adult female skier standing in a neutral A-pose: both arms hanging straight down and angled 45 degrees away from the body, elbows straight, hands open and relaxed with fingers together, legs straight and slightly apart, looking forward. Wearing a royal blue and yellow ski jacket, white ski pants, white ski helmet with dark goggles resting on the helmet, grey gloves, white ski boots. Realistic proportions, photorealistic',
    texture: 'photorealistic royal blue ski jacket with yellow accents, white ski pants, white glossy helmet, dark goggles, grey gloves, white ski boots, realistic face',
  },
  {
    name: 'skier_green',
    rig: true,
    pose: 'a-pose',
    polycount: 30000,
    prompt: 'Full body 3D game character of an adult male standing on flat ground in a neutral A-pose: both arms hanging straight down and angled 45 degrees away from the body, elbows straight, hands open and relaxed, legs straight and slightly apart, looking forward. Wearing a forest green and black ski jacket, dark grey ski pants, orange knitted beanie, goggles on the forehead, black gloves, and black ski boots on both feet. Only boots on the feet: no skis, no snowboard, no equipment attached to the feet. Realistic proportions, photorealistic',
    texture: 'photorealistic forest green ski jacket with black panels, dark grey ski pants, orange knitted beanie, goggles, black gloves, black ski boots, realistic face',
  },
  {
    name: 'ski_rental',
    polycount: 15000,
    prompt: 'A single modern alpine carving ski lying flat, long and thin with upturned tip, grey and light blue top sheet graphics, black ski binding mounted in the center, realistic product model',
  },
  {
    name: 'ski_sport',
    polycount: 15000,
    prompt: 'A single modern all mountain ski lying flat, long and thin with upturned tip, bright orange and black top sheet graphics, silver ski binding mounted in the center, realistic product model',
  },
  {
    name: 'ski_pro',
    polycount: 15000,
    prompt: 'A single professional world cup racing ski lying flat, long and thin with upturned tip, glossy red and white top sheet with carbon fiber pattern, red racing binding mounted in the center, realistic product model',
  },
  {
    name: 'ski_pole',
    polycount: 8000,
    prompt: 'A single straight ski pole standing vertically, very thin silver aluminum shaft, black rubber handle grip with a nylon wrist strap at the top, small round black plastic basket near the pointed steel tip at the bottom, realistic product model',
  },
  {
    name: 'rental_shop',
    tex4k: true,
    polycount: 140000,
    prompt: 'Alpine ski rental shop building, two story wooden chalet with thick snow on a pitched roof, large glass storefront windows showing skis inside, wooden sign above the entrance door, ski racks with skis standing outside, stone foundation, realistic game asset',
  },
  {
    name: 'gondola_station',
    polycount: 120000,
    prompt: 'Modern ski resort gondola lift base station building, steel frame and glass walls, large horizontal bullwheel under a curved roof, concrete platform, snow on the roof, realistic architectural game asset',
  },
  // gondola mid-stations (world/lifts.js): gondola_terminal (the arched glass hall between timber rooms) is the one in
  // use, on a built podium with its lanes cut free for the cabins; gondola_midstation (an A-frame shed, not a
  // pass-through) was dropped: its original is in assets-src/raw-unused
  {
    name: 'gondola_midstation',
    polycount: 90000,
    prompt: 'A modern alpine gondola lift mid-station building seen from the side: a long rectangular open-sided hall, a wide gently pitched dark grey standing-seam metal roof with a thick layer of snow on top, slim galvanized steel portal columns and roof trusses, warm larch timber ceiling under the roof, tall glass panel walls at both short ends, a timber-clad machine room base with windows, an elevated concrete boarding platform with yellow safety edge lines and steel railings, a steel staircase on one long side going down to the ground, the long sides completely open so gondola cabins can pass straight through the hall, no cabins, no cables, no people, standing alone, no ground, realistic architectural game asset',
    texture: 'dark grey standing-seam metal roof with white snow on top, galvanized steel columns and trusses, warm honey larch timber boards, clear blue-tinted glass panels with steel mullions, light grey concrete platform with yellow safety lines, steel railings, realistic PBR',
  },
  {
    name: 'gondola_terminal',
    polycount: 90000,
    prompt: 'A modern alpine gondola lift terminal station building: a long open-ended hall with a sleek curved white and glass roof, a large horizontal steel bullwheel at the back end under the roof, a boarding platform with steel railings and yellow safety lines, a timber and natural stone clad base with large windows and an entrance door, snow on the roof, no cabins, no cables, no people, standing alone, no ground, realistic architectural game asset',
    texture: 'white painted steel roof shell with snow on top, blue-tinted glass, galvanized steel bullwheel and frame, warm larch timber cladding, grey natural stone base, light grey concrete platform with yellow lines, realistic PBR',
  },
  // chairlift terminals (world/lifts.js MESHY_CHAIR): chair_terminal (a timber hut under a blue arched hood) is used as
  // the operator hut beside a built bullwheel; chair_terminal_b (an open canopy, too low for the chairs) was dropped:
  // its original is in assets-src/raw-unused
  {
    name: 'chair_terminal',
    polycount: 50000,
    prompt: 'A modern ski chairlift terminal station, three-quarter view: a large horizontal steel bullwheel about five meters across under a long rounded white and blue steel hood, held up high by a sturdy steel portal frame on a concrete foundation, open space under the bullwheel and hood where the chairs swing around, a small timber operator cabin with large windows standing beside the frame, snow on the hood and the cabin roof, no chairs, no cables, no people, standing alone, no ground, realistic game asset',
    texture: 'white and royal blue painted steel hood with snow on top, galvanized steel bullwheel and frame, warm larch timber operator cabin with white window frames and blue-tinted glass, grey concrete foundation, realistic PBR',
  },
  {
    name: 'chair_terminal_b',
    polycount: 50000,
    prompt: 'A detachable ski chairlift station seen from the side: a long low steel terminal housing with a curved grey and white metal roof raised on steel columns about six meters above the ground, a big horizontal bullwheel at one end under the roof, the space below the housing open for chairs to pass through, a small wooden operator hut with windows at one side, a short loading ramp of packed snow, snow on the roof, no chairs, no cables, no people, standing alone, no ground, realistic game asset',
    texture: 'grey and white painted steel roof and housing with snow on top, galvanized steel columns and bullwheel, warm larch timber hut with white window frames, blue-tinted glass, grey concrete footings, realistic PBR',
  },
  {
    name: 'gondola_cabin',
    polycount: 60000,
    prompt: 'Modern 8 seat ski gondola cabin, glossy red body with large panoramic tinted windows, steel hanger arm on top with cable grip, realistic game asset',
  },
  {
    name: 'chairlift_chair',
    polycount: 30000,
    prompt: 'Four seat ski chairlift chair with padded blue seats and backrest, steel safety bar with footrest, long vertical hanger arm with cable grip on top, realistic game asset',
  },
  {
    name: 'lift_tower',
    polycount: 25000,
    prompt: 'Tall grey steel ski lift tower pylon, tubular column with a crossarm on top holding sheave wheel assemblies on both sides, maintenance ladder, realistic game asset',
  },
  {
    name: 'pine_tree',
    polycount: 20000,
    prompt: 'A tall snow covered spruce fir tree, dense dark green needles with heavy white snow resting on the branches, conical shape, realistic game asset',
  },
  {
    name: 'pine_tree2',
    polycount: 20000,
    prompt: 'A tall slender alpine pine tree with light snow dusting on branches, dark green needles, brown trunk visible at the bottom, realistic game asset',
  },
  {
    name: 'rock',
    polycount: 25000,
    prompt: 'A large weathered grey granite boulder with angular facets, cracks and lichen, a few patches of snow on top, realistic photoscanned game asset',
  },
  {
    name: 'hotel_chalet',
    tex4k: true,
    polycount: 150000,
    prompt: 'Large luxury alpine hotel chalet building only, three stories, dark wooden facade with balconies, stone ground floor, heavy snow on a wide pitched roof, chimney, warm glowing windows. Building only: no trees, no ground plate, no base platform, realistic game asset',
  },
  {
    name: 'mountain_hut',
    tex4k: true,
    polycount: 120000,
    prompt: 'Rustic alpine mountain restaurant hut building, log cabin with a snow covered roof and a wooden terrace with benches. Building only: no trees, no ground plate, realistic game asset',
  },
  {
    name: 'race_arch',
    polycount: 30000,
    prompt: 'Inflatable red ski race start arch standing on snow, a big red inflatable arch with the word START, two thin timing gate posts below it. Only the arch and posts: no people, no mannequins, no characters, realistic game asset',
  },
  {
    name: 'ticket_booth',
    polycount: 50000,
    prompt: 'Small ski resort lift ticket booth kiosk, wooden walls, service window with counter, snow on the roof, realistic game asset',
  },
  {
    name: 'ski_elite',
    polycount: 15000,
    prompt: 'One single alpine downhill ski, side view, one continuous flat ski with one smoothly upturned tip, black top sheet with gold stripes, gold and black ski binding in the center, clean realistic product model',
  },
  {
    name: 'snow_cannon',
    polycount: 40000,
    prompt: 'Ski resort snow making fan gun snow cannon on a wheeled tower stand, large yellow cylindrical fan housing with nozzle ring, realistic game asset',
  },
  {
    name: 'lamp_post',
    polycount: 20000,
    prompt: 'Alpine village street lamp post, black cast iron pole with a lantern on top, snow on the lantern roof, realistic game asset',
  },
  // chairlift terminals (lifts.js chairTerminal): the bullwheel under its dome on one column, fitted to the rope
  // (third prompt: 'bullwheel' alone gave a vertical cable reel, a 'shallow dome' a squat unit)
  {
    name: 'chair_bullwheel',
    polycount: 40000,
    prompt: 'Top part of a modern detachable chairlift return station: a wide flat rounded white and blue steel hood shaped like a flattened disc, mounted horizontally high up on one single thick central steel column with a concrete foundation; a large horizontal bullwheel lying flat just under the hood, its rim visible all around; the area under the hood open; no chairs, no cables, no people, no text, standing alone, no ground, realistic game asset',
    texture: 'white painted steel hood with a royal blue band, light snow on top, galvanized steel bullwheel with black rubber liner, grey steel column, grey concrete foundation, realistic PBR',
  },
  // the village trail-map board (village.js makeTrailMapBoard): the map canvas covers its panel
  {
    name: 'map_board',
    polycount: 25000,
    prompt: 'An alpine ski resort information sign board: one large flat rectangular light grey sign panel, wider than tall, framed by dark brown wooden beams, mounted between two thick square wooden posts, a small pitched wooden roof with a light layer of snow above the panel, front view, the panel plain and empty, no letters, no symbols, no map, no people, no ground, standing alone, realistic game asset',
    texture: 'dark brown stained wood beams and posts, plain light grey panel, dark wooden shingle roof with light snow on top, realistic PBR',
  },
  // piste and village signposts (resortdressing.js buildSignposts): the bare pole the arrow boards hang on
  {
    name: 'sign_pole',
    polycount: 8000,
    prompt: 'One single tall straight square wooden signpost pole made of weathered larch timber, with a small four-sided pyramid metal cap on the top, bare with no signs and no arrows attached, standing alone, no text, no people, no ground, realistic game asset',
    texture: 'weathered brown larch timber with visible grain and small cracks, dark grey metal cap, realistic PBR',
  },
  // the World Cup finish arches' pylons (resortdressing.js buildArenas): the beam and its banners stay built
  {
    name: 'truss_pylon',
    polycount: 30000,
    prompt: 'One tall straight vertical steel lattice truss tower pylon for a ski race finish arch: a square cross-section box truss of four red painted steel tubes joined by diagonal white cross bracing, about seven meters tall and one meter thirty wide, a flat square steel base plate at the bottom, a flat top, standing alone, no banner, no text, no people, no ground, realistic game asset',
    texture: 'glossy red painted steel tubes, white painted diagonal bracing, galvanized bolts, dark steel base plate, realistic PBR',
  },
  // the ski bus stops (game/skibus.js buildStop): our printed face covers the plate
  {
    name: 'bus_stop_sign',
    polycount: 20000,
    prompt: 'A European alpine bus stop sign: one slim round galvanized steel pole about three meters tall standing in a small square concrete base, carrying at its top one flat rectangular sign plate, the plate plain yellow with a dark green border and completely blank, a small timetable case with a glass front fixed to the pole at eye height, no letters, no symbols, no text, no people, no ground, standing alone, realistic game asset',
    texture: 'yellow enamel sign plate with a dark green border, galvanized steel pole, glass timetable case with a white sheet behind, grey concrete base, realistic PBR',
  },
  // the ski shop's furniture (game/interior.js): the try-on and stove benches, the farmhouse table
  {
    name: 'shop_bench',
    polycount: 12000,
    prompt: 'A simple rustic wooden bench without a backrest for an alpine chalet shop: one thick solid larch seat plank on two sturdy slab board legs with a little carved cut-out, warm honey wood, standing alone, no people, no ground, realistic game asset',
    texture: 'warm honey-coloured larch wood with visible grain, slightly worn edges, realistic PBR',
  },
  {
    name: 'farm_table',
    polycount: 20000,
    prompt: 'An old rustic alpine farmhouse table: a thick scrubbed pine table top on four turned wooden legs joined by a plain apron, warm worn wood, nothing on the table, standing alone, no people, no ground, realistic game asset',
    texture: 'warm worn pine wood with visible grain, darker turned legs, realistic PBR',
  },
  // summit-hut terrace deck chairs (resortdressing.js buildTerraces), replacing the built frame + sling
  {
    name: 'deck_chair',
    polycount: 15000,
    prompt: 'A single classic wooden deck chair for a mountain hut sun terrace: a folding frame of natural varnished beech wood with a red and white striped canvas sling seat, reclined backrest, no armrests, standing alone, no people, no ground, realistic game asset',
    texture: 'natural varnished beech wood, red and white striped canvas fabric, small brass hinges, realistic PBR',
  },
  {
    name: 'wooden_bench',
    polycount: 20000,
    prompt: 'A sturdy alpine wooden park bench with a backrest and iron legs, light snow on the seat, realistic game asset',
  },
  {
    name: 'outdoor_ski_rack',
    polycount: 30000,
    prompt: 'Outdoor wooden ski rack at a ski resort holding several pairs of colorful skis and poles upright, light snow on top, realistic game asset',
  },
  {
    name: 'snowman',
    polycount: 20000,
    prompt: 'A classic snowman with three snowballs, carrot nose, coal eyes and buttons, stick arms, red knitted scarf and black top hat, realistic game asset',
  },
  {
    name: 'firewood_pile',
    polycount: 25000,
    prompt: 'A neat stacked pile of split firewood logs under a small wooden lean-to roof with snow on top, realistic game asset',
  },
  {
    name: 'wooden_fence',
    polycount: 15000,
    prompt: 'A short section of rustic alpine split-rail wooden fence, three meters long, light snow on the rails, realistic game asset',
  },
  {
    name: 'christmas_tree',
    polycount: 40000,
    prompt: 'A tall decorated Christmas fir tree for a town square, warm golden string lights, red and gold ornaments, star on top, light snow on branches, realistic game asset',
  },
  {
    name: 'picnic_table',
    polycount: 20000,
    prompt: 'A wooden picnic table with attached benches covered with a layer of fresh snow, realistic game asset',
  },
  {
    name: 'wooden_sled',
    polycount: 12000,
    prompt: 'A traditional wooden toboggan sled with curved runners and a red rope, realistic game asset',
  },
  {
    name: 'snowmobile',
    polycount: 40000,
    prompt: 'A modern red and black snowmobile parked, with skis at the front and a rubber track, realistic game asset',
  },
  {
    name: 'wooden_barrel',
    polycount: 12000,
    prompt: 'An old wooden barrel planter with iron bands and a small snow covered evergreen shrub on top, realistic game asset',
  },
  {
    name: 'trash_bin',
    polycount: 12000,
    prompt: 'A rustic wooden trash bin with a small slanted roof at an alpine ski resort, realistic game asset',
  },
  {
    name: 'market_stall',
    polycount: 50000,
    prompt: 'A small wooden alpine Christmas market stall hut with a snow covered roof, an open counter with mugs of mulled wine and pastries, warm string lights, realistic game asset',
  },
  {
    name: 'fire_pit',
    polycount: 20000,
    prompt: 'A round stone fire pit with burning logs and glowing embers surrounded by snow, realistic game asset',
  },
  {
    name: 'parked_suv',
    polycount: 50000,
    prompt: 'A dark green modern SUV car parked, covered with a layer of snow on the roof and hood, roof box on top, realistic game asset',
  },
  {
    name: 'helmet_shelf',
    polycount: 30000,
    prompt: 'A wooden wall display shelf in a ski shop with several colorful ski helmets and ski goggles on the shelves, realistic game asset',
  },
  {
    name: 'boot_rack',
    polycount: 30000,
    prompt: 'A ski shop display rack with rows of colorful alpine ski boots, wooden and metal shelving, realistic game asset',
  },
  {
    name: 'jacket_rail',
    polycount: 30000,
    prompt: 'A clothing rail in a ski shop with colorful ski jackets hanging on hangers, chrome rail on a stand, realistic game asset',
  },
  {
    name: 'shop_counter',
    polycount: 40000,
    prompt: 'A wooden shop sales counter with a cash register, a card terminal, a small stack of brochures and a bell, realistic game asset',
  },
  {
    name: 'potted_plant',
    polycount: 15000,
    prompt: 'A large potted indoor plant with green leaves in a ceramic pot, realistic game asset',
  },
  {
    name: 'glove_bin',
    polycount: 15000,
    prompt: 'A wooden display bin in a ski shop filled with colorful ski gloves and beanies, realistic game asset',
  },
  {
    name: 'skier_orange',
    rig: true,
    pose: 'a-pose',
    polycount: 30000,
    prompt: 'Full body 3D game character of an adult male ski racer standing on flat ground in a neutral A-pose: both arms hanging straight down and angled 45 degrees away from the body, elbows straight, hands open and relaxed, legs straight and slightly apart, looking forward. Wearing a tight-fitting orange and navy blue alpine racing suit with a white stripe, navy racing helmet with mirrored visor goggles, orange gloves, navy ski boots. Only boots on the feet: no skis, no snowboard, no equipment attached to the feet. Realistic proportions, photorealistic',
    texture: 'glossy orange and navy race suit with white stripes, navy helmet, mirror goggles, orange gloves, navy ski boots, realistic face',
  },
  {
    name: 'skier_black',
    rig: true,
    pose: 'a-pose',
    polycount: 30000,
    prompt: 'Full body 3D game character of an adult female winter athlete standing on flat ground in a neutral A-pose: both arms hanging down at 45 degrees away from the body, empty open hands holding nothing, legs straight and slightly apart, looking forward. Wearing a sleek black and white one-piece racing suit with geometric white panels, white helmet with black goggles, black gloves, and chunky white boots standing directly on the ground. Nothing attached to the feet, nothing in the hands. Realistic proportions, photorealistic',
    texture: 'black and white geometric one-piece suit, white glossy helmet, black goggles, black gloves, white boots, realistic face',
  },
  {
    name: 'skier_purple',
    rig: true,
    pose: 'a-pose',
    polycount: 30000,
    prompt: 'Full body 3D game character of an adult male winter athlete standing on flat ground in a neutral A-pose: both arms hanging down at 45 degrees away from the body, empty open hands holding nothing, legs straight and slightly apart, looking forward. Wearing a purple and teal insulated jacket, black trousers, purple helmet with teal goggles, black gloves, and chunky purple boots standing directly on the ground. Nothing attached to the feet, nothing in the hands. Realistic proportions, photorealistic',
    texture: 'purple jacket with teal accents, black trousers, purple helmet, teal goggles, black gloves, purple boots, realistic face',
  },
  {
    name: 'start_house',
    polycount: 40000,
    prompt: 'Alpine ski race start house: a small dark wooden hut with a steep roof fully covered in thick white snow, open front with a wooden start gate and a horizontal timing wand bar across the exit, red and white striped race banner along the roof edge, snowy wooden floor. Clean plain walls with no lettering, no grass, no plants, no people. Realistic game asset',
  },
  {
    name: 'grandstand',
    polycount: 60000,
    prompt: 'Small outdoor wooden grandstand bleachers for spectators at a ski race finish, five rows of benches, snow on the steps, realistic game asset. No people',
  },
  {
    name: 'timing_board',
    polycount: 30000,
    prompt: 'Large ski race finish scoreboard on two steel legs, black LED display screen panel with a red and white sponsor frame, realistic game asset',
  },
  {
    name: 'safety_net',
    polycount: 20000,
    prompt: 'Section of orange ski race safety B-net fence, orange mesh net stretched between black poles, about four meters long, realistic game asset',
  },
  {
    name: 'tunnel_portal',
    polycount: 60000,
    prompt: 'Arched mountain tunnel entrance portal carved into grey granite rock with snow on top, dark opening, wooden support beams at the entrance, realistic game asset',
  },
  {
    name: 'patrol_hut',
    polycount: 40000,
    prompt: 'Small red wooden ski patrol hut with a white cross sign on the door wall, white framed window, snow covered roof, small snowbank at the base. Only the hut: no people, no vehicles, no snowmobiles, no sleds. Realistic game asset',
  },
  {
    name: 'ski_cruiser',
    polycount: 15000,
    prompt: 'Exactly one single alpine ski lying flat, top sheet facing up, side view, one long thin flat ski (thin like a real ski) with one smoothly upturned tip, soft beginner ski with a light blue and white top sheet with simple stripes, white and blue binding mounted on top in the center of the ski (nothing sticking out to the sides), clean realistic product model',
  },
  {
    name: 'ski_park',
    polycount: 15000,
    prompt: 'One single freestyle twin tip park ski, side view, one long thin flat ski with both the tip and the tail gently upturned, bold purple and lime green graphic top sheet, a small low-profile black ski binding in the center (no boot), clean realistic product model',
  },
  {
    name: 'ski_powder',
    polycount: 15000,
    prompt: 'One single alpine ski, side view, one continuous flat ski with one smoothly upturned tip, wide rockered freeride powder ski with a bright orange and charcoal top sheet with mountain graphics, black freeride binding, ski binding mounted in the center, clean realistic product model',
  },
  {
    name: 'ski_touring',
    polycount: 15000,
    prompt: 'One single alpine ski, side view, one continuous flat ski with one smoothly upturned tip, lightweight ski touring ski with a forest green and grey top sheet, slim silver touring binding, ski binding mounted in the center, clean realistic product model',
  },
  {
    name: 'ski_carver',
    polycount: 15000,
    prompt: 'Exactly one single alpine ski lying flat, top sheet facing up, side view, one long thin slim flat ski (thin like a real ski, not a block) with one smoothly upturned tip, short slalom race carving ski with a glossy yellow and black top sheet with diagonal stripes, low yellow and black racing binding mounted on top in the center, clean realistic product model',
  },
  {
    name: 'ski_gs',
    polycount: 15000,
    prompt: 'One single alpine ski, side view, one continuous flat ski with one smoothly upturned tip, giant slalom world cup race ski with a glossy royal blue and white top sheet, blue racing plate binding, ski binding mounted in the center, clean realistic product model',
  },
  {
    name: 'ski_superg',
    polycount: 15000,
    prompt: 'One single alpine ski, side view, one continuous flat ski with one smoothly upturned tip, long super-G race ski with a glossy white top sheet with red and silver arrow graphics, red racing plate binding, ski binding mounted in the center, clean realistic product model',
  },
  {
    name: 'ski_legend',
    polycount: 15000,
    prompt: 'Exactly one single alpine ski lying flat, not a pair, not crossed, top sheet facing up, side view, one long thin flat ski with one smoothly upturned tip, premium luxury downhill ski with a pearl white top sheet with gold snowflake graphics and gold edges, gold and white binding mounted on top in the center, clean realistic product model',
  },
  {
    name: 'job_board',
    polycount: 25000,
    prompt: 'Alpine wooden notice board on two thick wooden posts with a small pitched roof covered in snow, a cork board with several pinned blank paper notes, standing alone, no text, no people, no ground, realistic game asset',
  },
  {
    name: 'delivery_backpack',
    polycount: 15000,
    prompt: 'A single red and grey mountain backpack with shoulder straps and buckles, upright, full and closed, realistic product model, no person',
  },
  {
    name: 'patrol_backpack',
    polycount: 15000,
    prompt: 'A single plain red first aid backpack with one large white cross on the front pocket and no lettering, no words, no text anywhere, shoulder straps, upright, closed, realistic product model, no person',
  },
  {
    name: 'mail_bag',
    polycount: 12000,
    prompt: 'A single brown leather postal mail satchel bag with a shoulder strap and a brass buckle, full of letters, closed, realistic product model',
  },
  {
    name: 'ski_glove',
    polycount: 8000,
    prompt: 'A single insulated ski glove lying flat, blue and black with a leather palm and a wrist strap, realistic product model',
  },
  {
    name: 'ski_goggles',
    polycount: 8000,
    prompt: 'A single pair of ski goggles with a mirrored orange lens and a black elastic strap, realistic product model',
  },
  {
    name: 'beanie',
    polycount: 8000,
    prompt: 'A single red knitted winter beanie hat with a white pompom on top, realistic product model',
  },
  {
    name: 'compact_camera',
    polycount: 8000,
    prompt: 'A single small black compact digital camera with a silver lens, realistic product model',
  },
  {
    name: 'rescue_sled',
    polycount: 20000,
    prompt: 'A red ski patrol rescue toboggan sled (akja) with a white cross, handles at both ends, empty, realistic game asset, no person, no ground',
  },
  {
    name: 'smartphone',
    polycount: 5000,
    prompt: 'A single modern smartphone lying flat, black glass screen, dark grey back, realistic product model',
  },
  {
    name: 'heli_body',
    polycount: 60000,
    prompt: 'A small modern mountain heli-skiing helicopter, red and white livery with a blue stripe, glass cockpit bubble, landing skids, ski racks on the side, tail boom with tail fin, WITHOUT any rotor blades (bare rotor hub on top and bare tail rotor hub), standing alone, no ground, no people, realistic game asset',
  },
  {
    name: 'piste_light',
    polycount: 20000,
    prompt: 'A tall ski slope night floodlight mast: one slim galvanized steel pole about 10 meters tall with a crossbar holding four rectangular stadium floodlight lamps at the top, small concrete foot, standing alone, no ground, no people, realistic game asset',
  },
  // night-skiing floodlights (world/pistelights.js): two lamp banks seen close up (each tipped per mast in code) and
  // a whole mast (its pole and cabinet are used). (floodlight_head and floodlight_mast_b were generated too and
  // dropped: a cluttered head / fanned lamps; their originals are in assets-src/raw-unused.)
  {
    name: 'floodlight_head_b',
    polycount: 16000,
    prompt: 'A floodlight bank for a ski slope mast, close-up: a square galvanized steel frame holding six rectangular LED stadium floodlights in two rows of three, all facing straight forward in the same direction, flat glass fronts with LED chip arrays, black aluminium housings with cooling fins on the back, a small steel mounting tube at the bottom middle of the frame, a thin layer of snow on top of the upper lamps, no pole, standing alone, no ground, realistic game asset',
    texture: 'galvanized grey steel frame, black aluminium floodlight housings with fins, bright white glass fronts with a grid of yellowish LED chips, white snow on top, realistic PBR',
  },
  {
    name: 'floodlight_head_c',
    polycount: 16000,
    prompt: 'A floodlight bank for a ski slope mast, close-up: a horizontal galvanized steel frame holding four rectangular LED stadium floodlights side by side in one row, all facing straight forward in the same direction, flat glass fronts with LED chip arrays, grey aluminium housings with cooling fins on the back, a small steel mounting tube at the bottom middle of the frame, a thin layer of snow on top of the lamps, no pole, standing alone, no ground, realistic game asset',
    texture: 'galvanized grey steel frame, dark grey aluminium floodlight housings with fins, bright white glass fronts with a grid of yellowish LED chips, white snow on top, realistic PBR',
  },
  {
    name: 'floodlight_mast',
    polycount: 24000,
    prompt: 'A tall ski resort night skiing floodlight mast, full view from base to top: a slim tapered galvanized steel pole about 12 meters tall bolted to a square concrete foundation block, a grey electrical junction box on the lower pole, and at the very top a steel crossarm carrying a bank of four rectangular LED floodlights angled forward and down, white glass fronts, dark grey housings with cooling fins, a small cap of snow on top of the lamps, standing alone, no ground, no people, realistic game asset',
  },
  {
    name: 'snowcat',
    polycount: 40000,
    prompt: 'A modern red piste grooming machine (snowcat) standing alone, side three-quarter view: two wide black rubber tracks, a wide hydraulic front snow blade, an enclosed cab with large dark tinted windows and a roof light bar with an orange beacon, a long rear tiller with a ribbed rubber finisher flap, red bodywork with white stripes, no people, no ground, no text, realistic game asset',
  },
  // the ski bus (game/skibus.js, game/bus/*): a yellow alpine post bus; its interior (seats, poles, glass) is our own
  {
    name: 'ski_bus',
    polycount: 150000,
    tex4k: true,
    // (regenerated at 150k triangles + 4k textures: the first coach, 38k, read jagged and blurry up close)
    prompt: 'A modern Swiss alpine post bus, a single-deck 12 metre regional coach standing alone, side three-quarter view: bright golden yellow bodywork with a thin red stripe along the bottom, a black roof edge, very large dark tinted side windows running the whole length of the bus, a big curved front windscreen with black wipers, two folding glass doors on the right side, round headlights, black bumpers, six black wheels with silver hubs, a ski rack box on the back, no people, no ground, no text, no logos, realistic game asset',
    texture: 'glossy golden yellow painted metal body, thin red stripe, black window frames, dark tinted glass, black rubber tyres, silver wheel hubs, realistic PBR',
  },
  // the Wolkenspitzbahn (world/railstations.js, world/train.js): station buildings, the railcar, its seats
  {
    name: 'rail_station_valley',
    polycount: 120000,
    prompt: 'Alpine mountain railway valley station building in a Swiss ski village, seen from the front: a long two storey building, rough grey stone ground floor with tall arched windows and a central entrance door, dark wooden upper floor with small windows and red shutters, steep gabled roof thickly covered in snow with deep overhangs, a round clock on the long side. Building only: no ground plate, no railway tracks, no platform, no trees, no people, no text, realistic game asset',
  },
  {
    name: 'rail_station_halt',
    polycount: 60000,
    prompt: 'Small alpine railway halt shelter: a wooden chalet style waiting room with a snow covered gable roof, an open front with a long wooden bench inside, a small window on each side wall, dark brown larch wood walls on a low grey stone base. Building only: no ground plate, no tracks, no trees, no people, no text, realistic game asset',
  },
  {
    name: 'rail_station_glacier',
    polycount: 120000,
    prompt: 'High alpine glacier summit station building: a grey stone ground floor with big windows and an entrance door, a modern panoramic glass hall on top with slim dark steel frames and a flat roof covered in snow, a red band below the roof edge, a small weather station mast on the roof. Building only: no ground plate, no mountain, no terrain, no people, no text, realistic game asset',
  },
  {
    name: 'rail_car',
    polycount: 100000,
    prompt: 'A single Swiss alpine rack railway passenger railcar standing alone, side three-quarter view: glossy red body with a thin white stripe, very long and narrow (about six times longer than wide), large panoramic side windows with black frames reaching up into the curved roof, a rounded streamlined driver cab at the front end with a big windshield and two headlights, a flat rear end with a gangway door, a pantograph on the roof, two bogies under the body. No rails, no ground, no people, no text, no logos, realistic game asset',
    texture: 'glossy red painted metal body, thin white stripe, black window frames, dark tinted glass, grey roof, dark grey bogies, realistic PBR',
  },
  {
    name: 'rail_seat_pair',
    polycount: 20000,
    prompt: 'A pair of modern train passenger seats side by side, dark blue fabric upholstery with high backrests and light grey headrests, grey plastic seat shells, an armrest between the seats, mounted on one steel pedestal, no floor, no people, realistic game asset',
  },
  // the Wolkenspitzbahn's railcar, second try (the first one came out short, with rails): body shell only, our bogies
  {
    name: 'rail_car2',
    polycount: 100000,
    prompt: 'A long modern Swiss mountain cogwheel railway passenger carriage body like the Zugspitze railcar, side three-quarter view, very long and low: about six times longer than its height, glossy red lower body with a white upper band, a continuous row of eight very large panoramic windows along the side reaching up into the curved roof edge, a sloped streamlined driver cab with a large wraparound windshield at one end, a flat end with a gangway door at the other end, a flat light grey roof. Carriage body only: no wheels, no bogies, no rails, no track, no ground, no pantograph, no people, no text, realistic game asset',
    texture: 'glossy red painted metal lower body, white upper band, black window frames, dark blue tinted panoramic glass, light grey roof, realistic PBR',
  },
  {
    name: 'rail_car3',
    polycount: 100000,
    prompt: 'Side view of a single long red and white panoramic tourist train carriage for a mountain railway, low and very elongated like a modern tram section, huge tinted panoramic windows covering most of the side and curving into the roof, a rounded aerodynamic front cab with a big windshield and two headlights, the body ends just above where the wheels would be. Body shell only: no wheels, no bogies, no rails, no ground, no people, no text, no logos, realistic game asset',
    texture: 'glossy red paint, white stripe, black window frames, dark tinted panoramic glass, light grey roof, realistic PBR',
  },
  // the ambulance after a heli rescue (game/heli/rescue.js) and the car parks' props (game/parking.js)
  {
    name: 'ambulance',
    polycount: 40000,
    prompt: 'A modern European alpine ambulance van standing alone, side three-quarter view: a high-roof white panel van with bright red and fluorescent yellow reflective chevron stripes along the sides and back, a blue emergency light bar on the roof, rear double doors, dark tinted windows, black wheels with snow tyres, a red cross symbol on the side, absolutely no text, no letters, no words, no ground, no people, realistic game asset',
    texture: 'glossy white painted van body, red and fluorescent yellow reflective chevron stripes, a plain red cross, blue roof lights, black rubber tyres, dark glass, no lettering, realistic PBR',
  },
  {
    name: 'parking_pay_machine',
    polycount: 16000,
    prompt: 'A modern car park pay station machine standing alone: a tall slim grey metal pillar kiosk with a small display screen, a card reader and coin slot, a ticket slot, a small rain hood on top, bolted to a low concrete base, a light dusting of snow on top, no text, no logos, no ground, realistic game asset',
    texture: 'brushed grey metal, black glass screen, small blue and green buttons, concrete base, white snow on top, realistic PBR',
  },
  {
    name: 'parking_sign',
    polycount: 8000,
    prompt: 'A European parking sign standing alone: a square blue road sign with a large white letter P, a thin white border, mounted on a single galvanized steel pole about 2.5 metres tall, a little snow on the top edge of the sign, no other text, no ground, realistic game asset',
    texture: 'reflective blue sign face with a crisp white letter P and white border, galvanized grey steel pole, white snow on top, realistic PBR',
  },
  // the small hospital the ambulance drives you to (game/hospital.js)
  {
    name: 'medical_centre',
    polycount: 50000,
    prompt: 'A small alpine village medical centre building standing alone, two storeys: white rendered walls with dark wooden balconies and window shutters, a pitched slate roof covered in snow, a glass entrance canopy at the front, a large plain red cross symbol on the white wall above the entrance, a small ambulance bay door at the side, no text, no letters, no signs with words, no ground, no people, realistic game asset',
    texture: 'white rendered walls, dark brown wood balconies and shutters, grey slate roof with thick white snow, glass canopy, a plain bright red cross, no lettering, realistic PBR',
  },
  // first-person driving hands (game/drive.js): a gloved left forearm and hand closed round a steering-wheel rim
  {
    name: 'driving_hand_a',
    polycount: 14000,
    prompt: 'A single realistic left human forearm and hand seen alone, wearing a modern black insulated winter ski glove, the four fingers naturally curled closed in a firm grip around an empty round space about 3 centimetres thick, as if holding a car steering wheel rim, the thumb lying along the top of the grip, the cuff of a dark navy ski jacket sleeve ending at mid-forearm, the forearm extends straight back from the wrist, nothing held in the hand, no bar, no steering wheel, no body, no ground, realistic game asset',
    texture: 'black technical ski glove fabric with subtle stitched panels and a darker grippy palm, dark navy ski jacket sleeve with an elastic cuff, realistic PBR',
  },
  {
    name: 'driving_hand_b',
    polycount: 14000,
    prompt: 'First-person game view model: a left arm from mid-forearm to the fingertips in a black leather and softshell winter glove, the hand gripping firmly around a thin invisible cylinder like a steering wheel, fingers wrapped around from behind, thumb on top along the grip, wrist straight, the dark ski jacket sleeve covering the forearm, isolated, the hand holds nothing visible, no object, no wheel, no ground, realistic game asset',
    texture: 'black leather and softshell ski glove with fine seams, dark charcoal ski jacket sleeve with a ribbed cuff, realistic PBR',
  },
  {
    name: 'driving_hand_c',
    polycount: 14000,
    prompt: 'A realistic gloved left hand and lower arm, a black padded winter glove with a short gauntlet, the hand closed in a relaxed natural driving grip as if holding a round bar 3 cm thick that is not there, fingers curled around, thumb resting on top, the dark ski jacket sleeve on the forearm, the arm continuing back from the wrist, single isolated hand, no bar, no steering wheel, no ground, realistic game asset',
    texture: 'black padded ski glove with grey stitching, dark navy ski jacket sleeve, realistic PBR',
  },
];
