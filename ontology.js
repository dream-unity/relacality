/**
 * The user's nine categories in their three permanent forms.
 * These meanings describe an imaginative ontology; they are not causal rules
 * automatically inferred from the musical timing of an exercise.
 */
export const CATEGORIES = Object.freeze([
  { id: 'all', name: 'All', short: 'All', definitions: {
    archetypal: 'Totality: a whole or the full collection under consideration.',
    inner: 'Form a collection or whole from within.',
    outer: 'Generate copies or likenesses outward.' } },
  { id: 'difference', name: 'Difference', short: 'Difference', definitions: {
    archetypal: 'Distinction: identify what differs or is set apart.',
    inner: 'Locate or distinguish what is inside.',
    outer: 'Locate or distinguish what is outside.' } },
  { id: 'action', name: 'Action', short: 'Action', definitions: {
    archetypal: 'Action: an operation or change.',
    inner: 'Act upon the self.',
    outer: 'Act from the self upon what is outside.' } },
  { id: 'division', name: 'Division', short: 'Division', definitions: {
    archetypal: 'Division: separate a whole or distinguish its parts.',
    inner: 'Remove or isolate the divided self.',
    outer: 'Subdivide or pluralise what is observed.' } },
  { id: 'connection', name: 'Connection', short: 'Connection', definitions: {
    archetypal: 'Connection: a relationship linking elements.',
    inner: 'A centre, hub, interface or linking medium.',
    outer: 'Members, possessions or termini connected through the medium.' } },
  { id: 'multiplication', name: 'Multiplication / Unfoldment', short: 'Unfoldment', definitions: {
    archetypal: 'Multiplication or unfoldment: a development into more or a fuller expression.',
    inner: 'Support, sustain or heal from within.',
    outer: 'Unfold, grow or blossom outward.' } },
  { id: 'projection', name: 'Projection', short: 'Projection', definitions: {
    archetypal: 'Projection: an extension in relation to a reference point.',
    inner: 'Receive or project toward the self.',
    outer: 'Project away from the self without bound.' } },
  { id: 'encompassment', name: 'Encompassment', short: 'Encompassment', definitions: {
    archetypal: 'Encompassment: containment in relation to a surrounding boundary.',
    inner: 'A containing boundary experienced from within, including expansion against it.',
    outer: 'Enclosure or engulfment imposed by the surrounding context.' } },
  { id: 'completion', name: 'Completion', short: 'Completion', definitions: {
    archetypal: 'Completion: fulfilment or attainment of an adequate whole.',
    inner: 'Internal sufficiency or attainment of a necessary condition.',
    outer: 'Structural adequacy within external bounds.' } },
].map(category => Object.freeze({ ...category, definitions: Object.freeze(category.definitions) })));

export const FORMS = Object.freeze([
  Object.freeze({ id: 'archetypal', label: 'Archetypal' }),
  Object.freeze({ id: 'inner', label: 'Inner' }),
  Object.freeze({ id: 'outer', label: 'Outer' }),
]);

const rows = ['qwertyuio', 'asdfghjkl', 'zxcvbnm,.'];
export const KEYS = Object.freeze(FORMS.flatMap((form, row) => CATEGORIES.map((category, column) => {
  const key = rows[row][column];
  return Object.freeze({
    id: `${form.id}-${category.id}`,
    categoryId: category.id,
    category: category.name,
    name: form.id === 'archetypal' ? category.name : `${form.label} ${category.name}`,
    form: form.id,
    formLabel: form.label,
    code: key === ',' ? 'Comma' : key === '.' ? 'Period' : `Key${key.toUpperCase()}`,
    key: key.toUpperCase(),
    midi: 48 + row * 9 + column,
    description: category.definitions[form.id],
  });
})));

export const KEY_BY_ID = new Map(KEYS.map(key => [key.id, key]));
export const KEY_BY_CODE = new Map(KEYS.map(key => [key.code, key]));
