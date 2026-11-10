import type { Cliente } from "../clientes/types.js";
import { hoy } from "../lib/fechas.js";
import type { RecetasRepository } from "../recetas/repository.js";
import type { Receta } from "../recetas/types.js";

/**
 * Q06: recetas de tratamiento prolongado en estado 'Vigente' cuya próxima dispensa es anterior a
 * hoy, con los datos del cliente.
 *
 * Motor: MongoDB. Un único pipeline sobre `recetas`: `$match` por tipo, estado y próxima dispensa
 * (con el índice compuesto sobre esos tres campos) y `$lookup` a `clientes`. "Hoy" es la fecha del
 * sistema: una próxima dispensa igual a hoy todavía no está atrasada.
 *
 * Parámetros: ninguno.
 * @returns cada receta con su `cliente`, de la próxima dispensa más atrasada a la más reciente.
 */
export async function q06RecetasProlongadasAtrasadas(
  recetas: RecetasRepository,
): Promise<(Receta & { cliente: Cliente })[]> {
  const filas = await recetas.vigentesConDispensaAntesDe("Tratamiento prolongado", hoy());
  return filas.map(({ receta, cliente }) => ({ ...receta, cliente }));
}
