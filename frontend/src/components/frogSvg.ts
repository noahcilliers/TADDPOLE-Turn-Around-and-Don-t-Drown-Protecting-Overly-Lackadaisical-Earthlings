// TADDPOLE mascot: a blue froglet (tadpole growing back legs), drawn nose-up in a 60×60 box
// with a wiggling tail. Shared by the map's car marker and the logo's "O".
const LEGS = 'M25 34 Q19 37 18 43 M18 43 l-3 1 M18 43 l0 3 M35 34 Q41 37 42 43 M42 43 l3 1 M42 43 l0 3'
const TAIL = [
  'M25 31 C24 42,36 46,33 57 C39 46,31 42,35 31 Z',
  'M25 31 C29 42,21 46,27 57 C29 46,36 42,35 31 Z',
]

const BODY = `
  <path d="${LEGS}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
  <path d="${LEGS}" fill="none" stroke="#1E40AF" stroke-width="2.4" stroke-linecap="round"/>
  <path d="${TAIL[0]}" fill="#3B82F6" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"><animate attributeName="d" dur="0.6s" repeatCount="indefinite" values="${TAIL[0]};${TAIL[1]};${TAIL[0]}"/></path>`

/** Just the face (eyes, head, smile); fits viewBox "16.5 8.5 27 29". `skin` is the head colour,
 *  `line` the smile. Static strings, no user input. */
export const frogFace = (skin: string, line: string) => `
  <circle cx="24" cy="16" r="5.5" fill="${skin}" stroke="#fff" stroke-width="2.5"/><circle cx="36" cy="16" r="5.5" fill="${skin}" stroke="#fff" stroke-width="2.5"/>
  <ellipse cx="30" cy="25" rx="12" ry="10.5" fill="${skin}" stroke="#fff" stroke-width="2.5"/>
  <circle cx="24" cy="16" r="4" fill="${skin}"/><circle cx="36" cy="16" r="4" fill="${skin}"/>
  <circle cx="24" cy="16" r="3.2" fill="#fff"/><circle cx="36" cy="16" r="3.2" fill="#fff"/>
  <circle cx="24" cy="15" r="1.7" fill="#0F172A"/><circle cx="36" cy="15" r="1.7" fill="#0F172A"/>
  <path d="M25 27 Q30 31 35 27" fill="none" stroke="${line}" stroke-width="1.6" stroke-linecap="round"/>`

/** Face for the logo's O, matching the blue "POLE" (--blue). */
export const FROG_FACE_BLUE = frogFace('#2563EB', '#fff')

/** Whole froglet for an <svg viewBox="0 0 60 60">. Static strings, no user input. */
export const FROG_SVG_INNER = BODY + frogFace('#2563EB', '#fff')
