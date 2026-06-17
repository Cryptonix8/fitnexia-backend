/** Maps legacy English location labels to Spanish display names. */
const LEGACY_LOCATION_MAP = {
  'Wellness Loft': 'Espacio Wellness',
  'Central Courts': 'Canchas Centrales',
  'FitHub Studio A': 'Sede FitHub — Sala A',
  'FitHub Downtown': 'Sede FitHub',
  FitHub: 'Sede FitHub',
};

function normalizeLocationLabel(value) {
  if (!value || typeof value !== 'string') return value || '';
  const trimmed = value.trim();
  return LEGACY_LOCATION_MAP[trimmed] || trimmed;
}

module.exports = { LEGACY_LOCATION_MAP, normalizeLocationLabel };
