const DISCIPLINES = [
  'Musculación',
  'Entrenamiento Funcional',
  'Entrenamiento Personalizado',
  'Entrenamiento para adultos mayores',
  'Entrenamiento para embarazadas',
  'Zumba/Ritmos',
  'Ciclismo indoor',
  'Pilates suelo/reformer',
  'Tenis',
  'Pádel',
  'Hidrogimnasia',
  'Natación',
  'Fútbol',
  'Basquetbol',
  'Voleibol',
  'Hockey',
  'Yoga',
  'Entrenamiento cross',
  'Otros',
];

/** Maps legacy English / old catalog values to the current list. */
const LEGACY_DISCIPLINE_MAP = {
  Yoga: 'Yoga',
  CrossFit: 'Entrenamiento cross',
  Crossfit: 'Entrenamiento cross',
  'Indoor Cycling': 'Ciclismo indoor',
  'Pilates Mat/Reformer': 'Pilates suelo/reformer',
  Tennis: 'Tenis',
  Swimming: 'Natación',
  HIIT: 'Entrenamiento Funcional',
  Pilates: 'Pilates suelo/reformer',
  Boxing: 'Otros',
  Running: 'Otros',
  Padel: 'Pádel',
  Pádel: 'Pádel',
};

function isValidDiscipline(value) {
  return typeof value === 'string' && DISCIPLINES.includes(value);
}

function normalizeDiscipline(value) {
  if (!value || typeof value !== 'string') return value;
  if (isValidDiscipline(value)) return value;
  return LEGACY_DISCIPLINE_MAP[value] || 'Otros';
}

function normalizeDisciplineList(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((item) => normalizeDiscipline(item)).filter(Boolean))];
}

module.exports = {
  DISCIPLINES,
  LEGACY_DISCIPLINE_MAP,
  isValidDiscipline,
  normalizeDiscipline,
  normalizeDisciplineList,
};
