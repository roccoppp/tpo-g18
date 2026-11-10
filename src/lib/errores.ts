/**
 * Rechazo esperado de un servicio de escritura: una validación que no pasa o un conflicto con otra
 * escritura. No modifica ningún dato. `npm run query` lo muestra como "Rechazado: <mensaje>".
 */
export class OperacionRechazada extends Error {
  override name = "OperacionRechazada";
}
