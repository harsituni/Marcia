# Stop photos and sources

## Jezero (Perseverance)

All photos: **NASA/JPL-Caltech** (public domain), taken by the Perseverance rover
at each sampling site. Resized to 960 px wide JPEG.

| File | Shows | Source image |
| --- | --- | --- |
| `wildcat-ridge.jpg` | Hazeltop core hole (sample 12), sol 509, Navcam | [mars-sample-12-nlf-0509…](https://science.nasa.gov/wp-content/uploads/2024/03/mars-sample-12-nlf-0509-0712140650-691ecm-n0261222ncam00709-01-095j.png) |
| `berea.jpg` | Melyn core site (sample 19), sol 750, Hazcam | [mars-sample-19-frf-0750…](https://science.nasa.gov/wp-content/uploads/2024/03/mars-sample-19-frf-0750-0733519147-132ecm-n0370000fhaz02008-03-095j.png) |
| `hidden-harbor.jpg` | Kukaklek core hole (sample 16), sol 628, Mastcam-Z | [mars-sample-16-zl0-0628…](https://science.nasa.gov/wp-content/uploads/2024/03/mars-sample-16-zl0-0628-0722694488-535eby-n0301172zcam03492-1100lmj.png) |
| `amalik.jpg` | Shuyak core hole (sample 14), sol 575, Navcam | [mars-sample-14-nlf-0575…](https://science.nasa.gov/wp-content/uploads/2024/03/mars-sample-14-nlf-0575-0717997335-774ecm-n0290000ncam00709-01-095j.png) |

Image list: [NASA Mars rock samples](https://science.nasa.gov/mission/mars-2020-perseverance/mars-rock-samples/).

## Stop locations

Each `cell` is the rover's last drive end before the core was drilled, from
NASA's [M20 waypoint track](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json),
mapped onto the 600 × 600, 5 m grid spanning `data/sites/jezero/site.json`'s bounds
(x from longitude, y from latitude; the eqc grid is linear in both).

| Stop | Drill sol | Waypoint sol | lon, lat | Cell |
| --- | --- | --- | --- | --- |
| Wildcat Ridge | 509 | 502 | 77.40592, 18.45865 | 310, 375 |
| Berea | 749 | 736 | 77.38407, 18.47020 | 64, 238 |
| Hidden Harbor | 623 | 609 | 77.39915, 18.45364 | 234, 434 |
| Amalik | 575 | 565 | 77.40144, 18.45073 | 259, 469 |

## Geology and minerals

- Wildcat Ridge, Hidden Harbor, Amalik: Bosak et al. (2024), *Astrobiological
  Potential of Rocks Acquired by the Perseverance Rover at a Sedimentary Fan
  Front in Jezero Crater, Mars*, AGU Advances,
  [doi:10.1029/2024AV001241](https://doi.org/10.1029/2024AV001241)
  (Tables 1–2, §3.1–3.2).
- Berea: NASA, [Meet the Mars Samples: Melyn (Sample 19)](https://science.nasa.gov/resource/meet-the-mars-samples-melyn-sample-19)
  (carbonate-rich river sandstone, first upper-fan sample).

Goals and science values are ours (crew planning), ranked by the paper's
assessment: Wildcat Ridge has the highest organic-preservation potential.

## Gale (Curiosity, M36)

All photos: **NASA/JPL-Caltech** (public domain), raw Front Hazcam (left, B-side)
frames from [Curiosity's raw images](https://mars.nasa.gov/msl/multimedia/raw-images/),
taken at each drill site. Resized to 960 px wide JPEG. The site/drive in each
file name (e.g. `F1161944` = site 116, drive 1944) matches the waypoint below.

| File | Shows | Sol | Source image |
| --- | --- | --- | --- |
| `gale-altadena.jpg` | Arm at the Altadena drill site | 4564 | [FLB_802661004…](https://mars.nasa.gov/msl-raw-images/proj/msl/redops/ods/surface/sol/04564/opgs/edr/fcam/FLB_802661004EDR_F1161944FHAZ00337M_.JPG) |
| `gale-valle-de-la-luna.jpg` | Arm at the Valle de la Luna block, Monte Grande hollow | 4690 | [FLB_813838299…](https://mars.nasa.gov/msl-raw-images/proj/msl/redops/ods/surface/sol/04690/opgs/edr/fcam/FLB_813838299EDR_F1191722FHAZ00208M_.JPG) |
| `gale-atacama.jpg` | Atacama drill site | 4877 | [FLB_830445127…](https://mars.nasa.gov/msl-raw-images/proj/msl/redops/ods/surface/sol/04877/opgs/edr/fcam/FLB_830445127EDR_F1220000FHAZ00191M_.JPG) |
| `gale-nazca.jpg` | Nazca drill site | 5050 | [FLB_845809821…](https://mars.nasa.gov/msl-raw-images/proj/msl/redops/ods/surface/sol/05050/opgs/edr/fcam/FLB_845809821EDR_F1251326FHAZ00337M_.JPG) |

### Stop locations

Each `cell` is Curiosity's drive end for that site from NASA's
[MSL waypoint track](https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json),
mapped onto the 600 × 600, 5 m grid spanning `data/sites/gale/site.json`'s bounds.

| Stop | Drill sols | Waypoint (sol, site_drive) | lon, lat | Cell |
| --- | --- | --- | --- | --- |
| Altadena | 4564 | 4560, 116_1944 | 137.38354, -4.79985 | 400, 155 |
| Valle de la Luna | 4689 | 4687, 119_1722 | 137.38104, -4.80784 | 371, 250 |
| Atacama | 4876–4878 | 4868, 122_0 | 137.38171, -4.81427 | 379, 326 |
| Nazca | 5050–5055 | 5045, 125_1326 | 137.38761, -4.82466 | 448, 450 |

### Sources for goals and geology

NASA Curiosity blog: [Altadena](https://science.nasa.gov/blog/curiosity-blog-sols-4568-4569-a-close-look-at-the-altadena-drill-hole-and-tailings/),
[Valle de la Luna](https://science.nasa.gov/blog/curiosity-blog-sols-4689-4694-drill-in-the-boxwork-unit-is-go/)
and [Nevado Sajama](https://science.nasa.gov/blog/curiosity-blog-sols-4709-4715-drilling-high-and-low-in-the-boxwork-unit),
[Atacama](https://science.nasa.gov/blog/curiosity-blog-sols-4873-4878-welcome-to-the-atacama-drill-target/),
[Nazca](https://science.nasa.gov/blog/curiosity-blog-sols-5043-5049-preparing-to-drill-at-nazca/),
[campaign phases](https://science.nasa.gov/blog/curiosity-blog-sols-4804-4811-kicking-off-the-final-phase-of-boxwork-exploration).
Goals and science values are ours (crew planning).
