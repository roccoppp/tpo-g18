import type { Cliente } from "../clientes/types.js";
import type { RecetasRepository } from "../recetas/repository.js";

/** La consulta pide los clientes con más de esta cantidad de recetas. */
const MAS_DE_RECETAS = 1;

/**
 * Q04: clientes con más de una receta registrada, indicando la cantidad.
 *
 * Motor: MongoDB. Un único pipeline de agregación sobre `recetas`: `$group` por `id_cliente`,
 * `$match` sobre la cantidad y `$lookup` a `clientes` para traer los datos de cada cliente. Cuenta
 * las recetas en cualquier estado (vigentes, completadas o vencidas): todas quedaron registradas.
 *
 * Parámetros: ninguno.
 * @returns los datos de cada cliente con `cantidad_recetas`, de mayor a menor cantidad y, a igual
 * cantidad, por id de cliente.
 */
export async function q04ClientesConVariasRecetas(
  recetas: RecetasRepository,
): Promise<(Cliente & { cantidad_recetas: number })[]> {
  const filas = await recetas.clientesConMasRecetasQue(MAS_DE_RECETAS);
  return filas.map(({ cliente, cantidad }) => ({ ...cliente, cantidad_recetas: cantidad }));
}
