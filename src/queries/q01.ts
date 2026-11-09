import type { ProductosRepository } from "../productos/repository.js";
import type { Producto } from "../productos/types.js";
import type { Proveedor } from "../proveedores/types.js";

export type ProductoConProveedor = Producto & { proveedor: Proveedor };

/**
 * Q01: productos activos con todos los datos de su proveedor.
 *
 * Motor: Neo4j. Se resuelve con un único patrón, (:Producto)-[:PROVISTO_POR]->(:Proveedor),
 * sobre la copia del catálogo en el grafo: un solo viaje, sin combinar en la aplicación.
 *
 * Parámetros: ninguno.
 * @returns los productos ordenados por id.
 */
export async function q01ProductosActivosConProveedor(
  productos: ProductosRepository,
): Promise<ProductoConProveedor[]> {
  const filas = await productos.activosConProveedor();
  return filas.map(({ producto, proveedor }) => ({ ...producto, proveedor }));
}
