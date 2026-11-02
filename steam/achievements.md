# Ski Legacy: Steam achievements

Enter these in **Steamworks -> App Admin -> Stats & Achievements -> Achievements** (one "New Achievement" each).
The **API name must match exactly** (the game unlocks by API name, `src/core/steam.js` `ACHIEVEMENTS`). Set
**Set By** to *Client*, leave **Hidden** off (or on for ARRESTED / POLICE_ESCAPE if you prefer surprises), then
**Publish** the changes (Stats & Achievements changes are not live until you publish them in Steamworks).

| # | API name | Display name | Description | Icon files (achieved / unachieved) |
|---|----------|--------------|-------------|-------------------------------------|
| 1 | `FIRST_RUN` | First Tracks | Finish your first race. | first_run.jpg / first_run_locked.jpg |
| 2 | `FIRST_WIN` | Top of the Podium | Win a race. | first_win.jpg / first_win_locked.jpg |
| 3 | `WINS_10` | Serial Winner | Win 10 races. | wins_10.jpg / wins_10_locked.jpg |
| 4 | `ALL_COURSES` | Course Collector | Finish every World Racing course on the mountains. | all_courses.jpg / all_courses_locked.jpg |
| 5 | `SPEED_100` | Ton Up | Reach 100 km/h on skis. | speed_100.jpg / speed_100_locked.jpg |
| 6 | `SPEED_130` | Downhill Demon | Reach 130 km/h on skis. | speed_130.jpg / speed_130_locked.jpg |
| 7 | `DISTANCE_100K` | Marathon Skier | Ski a total of 100 km. | distance_100k.jpg / distance_100k_locked.jpg |
| 8 | `SKIS_LEGEND` | Gold Edition | Own the Legacy Gold Edition skis. | skis_legend.jpg / skis_legend_locked.jpg |
| 9 | `FIRST_CAR` | Wheels | Buy your first car at the Autohaus. | first_car.jpg / first_car_locked.jpg |
| 10 | `CARS_5` | Car Collector | Own 5 cars at once. | cars_5.jpg / cars_5_locked.jpg |
| 11 | `FIRST_CHALET` | Home in the Alps | Buy a chalet. | first_chalet.jpg / first_chalet_locked.jpg |
| 12 | `FURNISHED` | Interior Designer | Place 15 pieces of furniture in your chalet. | furnished.jpg / furnished_locked.jpg |
| 13 | `TAXI_FIRST` | Meter Running | Complete your first taxi fare. | taxi_first.jpg / taxi_first_locked.jpg |
| 14 | `TAXI_25` | Legacy Cabbie | Complete 25 taxi fares. | taxi_25.jpg / taxi_25_locked.jpg |
| 15 | `POLICE_ESCAPE` | Gone in the Snow | Escape a police chase. | police_escape.jpg / police_escape_locked.jpg |
| 16 | `ARRESTED` | Behind Bars | Get arrested and spend time in jail. | arrested.jpg / arrested_locked.jpg |
| 17 | `EXPRESS_RIDE` | All Aboard | Ride the Legacy Express. | express_ride.jpg / express_ride_locked.jpg |
| 18 | `LEGACY_PEAK` | Roof of the Resort | Stand on the summit of Legacy Peak (4,000 m). | legacy_peak.jpg / legacy_peak_locked.jpg |
| 19 | `HELI_PILOT` | Pilot | Fly a helicopter. | heli_pilot.jpg / heli_pilot_locked.jpg |
| 20 | `RESCUED` | Air Rescue | Get rescued after a bad crash. | rescued.jpg / rescued_locked.jpg |
| 21 | `SECRET_FIRST` | Explorer | Find a secret. | secret_first.jpg / secret_first_locked.jpg |
| 22 | `MONEY_100K` | Six Figures | Have $100,000. | money_100k.jpg / money_100k_locked.jpg |
| 23 | `MONEY_1M` | Ski Tycoon | Have $1,000,000. | money_1m.jpg / money_1m_locked.jpg |

How each one is detected (all no-ops without Steam):

- Race ones (FIRST_RUN, FIRST_WIN, WINS_10, ALL_COURSES): `main.js` courseResult / busRaceResult (practice runs never count).
  ALL_COURSES needs every World Racing course on the mountains finished at least once *since Steam achievements were added*
  (the list of finished courses is kept in the browser profile, key `ski-legacy-steam-v1`).
- TAXI_FIRST / TAXI_25: `game/taxi.js` (a paid fare). POLICE_ESCAPE: `game/police.js` escaped(). ARRESTED: `game/prison.js` jail().
- Everything else: `steamTick()` once a second from the main loop (save: money, top speed, distance, owned skis, garage,
  chalet + furniture, rescues, secrets; riding the Legacy Express; flying the helicopter; standing within ~45 m of the
  Legacy Peak summit).
- Old saves that already qualify unlock the state-based ones the first time the game runs through Steam.

Testing: in Steamworks you can reset your own achievements while testing; from code, steamworks.js has
`client.stats.resetAll(true)` (not wired to the game on purpose).

## Icons (placeholder spec: check the current Steamworks docs)

- Two images per achievement: **achieved** (colour) and **unachieved** (usually the same art in grey).
- **256 x 256 px, JPG or PNG** (Steamworks scales them down; it currently asks for 256x256, older docs said 64x64).
- Square, no transparency needed, readable at 64 px: one simple symbol per achievement (ski, trophy, speedometer,
  car, chalet, taxi sign, police light, train, mountain peak, helicopter, $), the game's navy (#0b1626) and gold.
- Suggested file names: the Icon column above, e.g. `first_win.jpg` and `first_win_locked.jpg`, kept in
  `steam/achievement-icons/` (not included yet: make or commission them).
