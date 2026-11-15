// TADDPOLE mascot: a blue froglet (tadpole growing back legs) in a yellow raincoat with the
// hood up, drawn nose-up in a 60×60 box with a wiggling tail. Shared by the map's car marker,
// the recenter button and the logo's "O". All markup is static strings, no user input.
const LEGS = 'M25 34 Q19 37 18 43 M18 43 l-3 1 M18 43 l0 3 M35 34 Q41 37 42 43 M42 43 l3 1 M42 43 l0 3'
const TAIL = [
  'M25 31 C24 42,36 46,33 57 C39 46,31 42,35 31 Z',
  'M25 31 C29 42,21 46,27 57 C29 46,36 42,35 31 Z',
]
const COAT_YELLOW = '#FACC15'
const COAT_TRIM = '#CA8A04'
const HOOD_PATH = 'M13 30 C11 12,20 3,30 3 C40 3,49 12,47 30 C42 37.5,18 37.5,13 30 Z'

const BODY = `
  <path d="${LEGS}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
  <path d="${LEGS}" fill="none" stroke="#1E40AF" stroke-width="2.4" stroke-linecap="round"/>
  <path d="${TAIL[0]}" fill="#3B82F6" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"><animate attributeName="d" dur="0.6s" repeatCount="indefinite" values="${TAIL[0]};${TAIL[1]};${TAIL[0]}"/></path>`

/** Raincoat body under the head, with a seam and two buttons. */
const COAT = `
  <path d="M19 29 Q17.5 41 21.5 44.5 L38.5 44.5 Q42.5 41 41 29 Z" fill="${COAT_YELLOW}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M30 33 L30 44" stroke="${COAT_TRIM}" stroke-width="1"/>
  <circle cx="32.2" cy="37" r="0.95" fill="${COAT_TRIM}"/><circle cx="32.2" cy="41" r="0.95" fill="${COAT_TRIM}"/>`

/** Hood framing the face (drawn behind it), with a white outline for contrast on the map. */
const HOOD = `
  <path d="${HOOD_PATH}" fill="none" stroke="#fff" stroke-width="4.5"/>
  <path d="${HOOD_PATH}" fill="${COAT_YELLOW}" stroke="${COAT_TRIM}" stroke-width="1.2"/>
  <path d="M30 3 L30 7" stroke="${COAT_TRIM}" stroke-width="1.2" stroke-linecap="round"/>`

/** Just the face (eyes, head, smile). `skin` is the head colour, `line` the smile. */
export const frogFace = (skin: string, line: string) => `
  <circle cx="24" cy="16" r="5.5" fill="${skin}" stroke="#fff" stroke-width="2.5"/><circle cx="36" cy="16" r="5.5" fill="${skin}" stroke="#fff" stroke-width="2.5"/>
  <ellipse cx="30" cy="25" rx="12" ry="10.5" fill="${skin}" stroke="#fff" stroke-width="2.5"/>
  <circle cx="24" cy="16" r="4" fill="${skin}"/><circle cx="36" cy="16" r="4" fill="${skin}"/>
  <circle cx="24" cy="16" r="3.2" fill="#fff"/><circle cx="36" cy="16" r="3.2" fill="#fff"/>
  <circle cx="24" cy="15" r="1.7" fill="#0F172A"/><circle cx="36" cy="15" r="1.7" fill="#0F172A"/>
  <path d="M25 27 Q30 31 35 27" fill="none" stroke="${line}" stroke-width="1.6" stroke-linecap="round"/>`

const FACE_BLUE = frogFace('#2563EB', '#fff')

/** Hooded face for the logo's "O"; fits viewBox "10 0.5 40 37" (same art as public/favicon.svg). */
export const FROG_HOODED_FACE = HOOD + FACE_BLUE

/** Whole froglet in its raincoat for an <svg viewBox="0 0 60 60">. */
export const FROG_SVG_INNER = BODY + COAT + HOOD + FACE_BLUE
