import { divIcon } from 'leaflet';

/**
 * Pins are HTML divIcons (styled in index.css), so there are no marker image
 * files for the bundler to lose.
 */

export const habitatIcon = divIcon({
  className: 'pin pin-habitat',
  html: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18h18v2H3zM4 17a8 8 0 0 1 16 0z"/></svg>`,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
  tooltipAnchor: [0, -16],
});

const stopIcons = new Map<string, ReturnType<typeof divIcon>>();

/** Numbered stop pin; `n` is the 1-based visiting order. */
export function stopIcon(n: number, selected = false) {
  const key = `${n}${selected ? 's' : ''}`;
  let icon = stopIcons.get(key);
  if (!icon) {
    icon = divIcon({
      className: selected ? 'pin pin-stop pin-selected' : 'pin pin-stop',
      html: `<span>${n}</span>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      tooltipAnchor: [0, -14],
    });
    stopIcons.set(key, icon);
  }
  return icon;
}
