import type { Producto } from "../productos/types.js";
import type { VentasRepository } from "../ventas/repository.js";

/** La consulta pide los cinco productos más vendidos. */
const CANTIDAD_PRODUCTOS = 5;

/**
 * Q07: top 5 productos más vendidos en unidades, considerando solo las ventas 'Completada'.
 *
 * Motor: MongoDB. Un único pipeline sobre `ventas`: `$match` por estado, `$unwind` de los ítems
 * embebidos, `$group` por producto sumando `cantidad`, `$sort` + `$limit` y `$lookup` a `productos`
 * para traer los datos de cada producto. Los productos discontinuados también cuentan: se vendieron.
 *
 * Parámetros: ninguno.
 * @returns los datos de cada producto con `unidades_vendidas`, de mayor a menor. A igual cantidad
 * de unidades, ordena por id de producto, así que un empate en el quinto puesto se resuelve por id.
 */
export async function q07TopProductosVendidos(
  ventas: VentasRepository,
): Promise<(Producto & { unidades_vendidas: number })[]> {
  const filas = await ventas.productosMasVendidos(CANTIDAD_PRODUCTOS);
  return filas.map(({ producto, unidades }) => ({ ...producto, unidades_vendidas: unidades }));
}
