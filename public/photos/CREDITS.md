# Stop photos and sources

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
mapped onto the 600 × 600, 5 m grid spanning `data/site.json`'s bounds
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
