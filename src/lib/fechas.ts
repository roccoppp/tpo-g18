// Fechas relativas a "hoy" para las consultas que dependen de la fecha actual (q05, q06, q11, q12).
// Siempre se calculan con la fecha del sistema, nunca con fechas fijas. Las fechas del dominio se
// guardan como medianoche UTC del día (así las construye la carga), así que estas funciones
// devuelven también medianoche UTC, para comparar día contra día.

/** Medianoche UTC del día de hoy, según el calendario local del sistema. */
export function hoy(): Date {
  const ahora = new Date();
  return new Date(Date.UTC(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()));
}

/** La fecha `dias` días después de `fecha`. */
export function sumarDias(fecha: Date, dias: number): Date {
  return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate() + dias));
}

/** La fecha `dias` días antes de `fecha`. */
export function restarDias(fecha: Date, dias: number): Date {
  return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate() - dias));
}

/**
 * La misma fecha `anios` años antes. Si ese día no existe (29 de febrero en un año no bisiesto),
 * pasa al 1 de marzo.
 */
export function restarAnios(fecha: Date, anios: number): Date {
  return new Date(Date.UTC(fecha.getUTCFullYear() - anios, fecha.getUTCMonth(), fecha.getUTCDate()));
}

/** El primer día del mes de `fecha`. */
export function inicioDeMes(fecha: Date): Date {
  return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), 1));
}

/** El primer día del mes siguiente al de `fecha`. */
export function inicioDelMesSiguiente(fecha: Date): Date {
  return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth() + 1, 1));
}
