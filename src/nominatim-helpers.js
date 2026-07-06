/**
 * Adressen: OSM addr:*-Tags (zuverlässig, wenn gemappt) + Nominatim Reverse
 * (Nutzungsbedingungen: max. ~1 Anfrage/s, aussagekräftiger User-Agent)
 */
'use strict';

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const DEFAULT_UA = 'Noortec-RoofIdentifier/1.0 (crm; https://nominatim.org/policies)';

/**
 * @param {Record<string, string|undefined>|null|undefined} tags
 * @returns {string|null}
 */
function formatAddressFromOsmTags(tags) {
  if (!tags || typeof tags !== 'object') return null;
  const st = tags['addr:street'] || tags['addr:place'] || tags['addr:hamlet'] || tags['addr:suburb'];
  const hn = tags['addr:housenumber'] || tags['addr:unit'] || '';
  const plz = tags['addr:postcode'] || '';
  const city = tags['addr:city'] || tags['addr:town'] || tags['addr:village']
    || tags['addr:municipality'] || '';
  if (!st && !plz && !city) return null;
  const line1 = [st, hn].filter(Boolean).join(' ').trim();
  const line2 = [plz, city].filter(Boolean).join(' ').trim();
  if (line1 && line2) return `${line1}, ${line2}`;
  return line1 || line2 || null;
}

/**
 * @param {object} data Nominatim-JSON
 * @returns {string|null}
 */
function formatAddressFromNominatimData(data) {
  if (!data) return null;
  if (data.error) return null;
  if (data.address) {
    const a = data.address;
    const road = a.road || a.footway || a.pedestrian || a.residential
      || a.industrial || a.commercial || a.path;
    const hn = a.house_number;
    const plz = a.postcode;
    const ort = a.city || a.town || a.village || a.municipality || a.hamlet
      || a.suburb;
    const l1 = [road, hn].filter(Boolean).join(' ').trim();
    const l2 = [plz, ort].filter(Boolean).join(' ').trim();
    if (l1 && l2) return `${l1}, ${l2}`;
    if (l2) return l1 ? `${l1}, ${l2}` : l2;
    if (l1) return l1;
  }
  if (data.display_name) {
    const p = data.display_name.split(',').map(s => s.trim());
    if (p.length > 4) return p.slice(0, 3).join(', ');
    return data.display_name;
  }
  return null;
}

function isMissingOrPlaceholderAddress(s) {
  if (s == null) return true;
  const t = String(s).trim();
  return t === '' || t === '—' || t === '–';
}

let _lastNominatim = 0;
const MIN_MS = 1100;

function delayUntilNominatimSlot() {
  return new Promise((resolve) => {
    const wait = Math.max(0, MIN_MS - (Date.now() - _lastNominatim));
    setTimeout(() => { _lastNominatim = Date.now(); resolve(); }, wait);
  });
}

/**
 * Reverse-Geocoding (Hausnummer/ Straße, wo in OSM hinterlegt)
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<string|null>}
 */
async function reverseGeocodeLatLng(lat, lng) {
  if (!isFinite(lat) || !isFinite(lng)) return null;
  await delayUntilNominatimSlot();
  const url = `${NOMINATIM}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&format=json&addressdetails=1&zoom=18&accept-language=de`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': process.env.NOMINATIM_UA || DEFAULT_UA,
      Accept:       'application/json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return formatAddressFromNominatimData(data);
}

module.exports = {
  formatAddressFromOsmTags,
  formatAddressFromNominatimData,
  reverseGeocodeLatLng,
  isMissingOrPlaceholderAddress,
  delayUntilNominatimSlot,
};
