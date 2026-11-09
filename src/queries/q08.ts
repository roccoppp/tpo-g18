import type { LotesRepository } from "../lotes/repository.js";
import type { Lote } from "../lotes/types.js";
import type { Producto } from "../productos/types.js";
import type { Proveedor } from "../proveedores/types.js";
import type { Sucursal } from "../sucursales/types.js";

/** La consulta pide los lotes con menos de esta cantidad de unidades. */
const UMBRAL_UNIDADES = 50;

export type LoteConRelaciones = Lote & {
  producto: Producto;
  sucursal: Sucursal;
  proveedor: Proveedor;
};

/**
 * Q08: lotes con menos de 50 unidades, con su producto, su sucursal y el proveedor del producto.
 *
 * Motor: Neo4j. Se resuelve con un único patrón que recorre las tres relaciones del lote,
 *   (:Lote)-[:DE_PRODUCTO]->(:Producto)-[:PROVISTO_POR]->(:Proveedor) y (:Lote)-[:EN_SUCURSAL]->(:Sucursal),
 * filtrado por `unidades`, en un solo viaje. Las unidades se leen de la copia del grafo: el
 * descuento de stock (q15) la actualiza después de confirmar su transacción en MongoDB.
 *
 * Parámetros: ninguno.
 * @returns los lotes ordenados por id.
 */
export async function q08LotesConStockBajo(lotes: LotesRepository): Promise<LoteConRelaciones[]> {
  const filas = await lotes.conMenosUnidadesQue(UMBRAL_UNIDADES);
  return filas.map(({ lote, producto, sucursal, proveedor }) => ({
    ...lote,
    producto,
    sucursal,
    proveedor,
  }));
}
