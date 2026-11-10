import type { FarmaceuticosRepository } from "../farmaceuticos/repository.js";
import type { Farmaceutico } from "../farmaceuticos/types.js";
import { hoy, restarDias } from "../lib/fechas.js";

/** La consulta cuenta las ventas de esta cantidad de días hacia atrás. */
const DIAS = 60;

/**
 * Q05: farmacéuticos activos y la cantidad de ventas que registraron en los últimos 60 días,
 * excluyendo las anuladas. Aparecen también los que tienen cero.
 *
 * Motor: Neo4j. Un único patrón: cada (:Farmaceutico {activo: true}) con su sucursal y un
 * `OPTIONAL MATCH` a las (:Venta) que le llegan por ATENDIDA_POR, filtradas por fecha y estado. El
 * patrón opcional es el que conserva a los farmacéuticos sin ventas, con cantidad 0.
 *
 * "Últimos 60 días" va desde hoy menos 60 días hasta hoy, ambos inclusive, con la fecha del sistema.
 * Cuenta las ventas 'Completada' y las 'Pendiente'.
 *
 * Parámetros: ninguno.
 * @returns los datos de cada farmacéutico con `cantidad_ventas`, de mayor a menor cantidad y, a
 * igual cantidad, por id.
 */
export async function q05FarmaceuticosConVentasRecientes(
  farmaceuticos: FarmaceuticosRepository,
): Promise<(Farmaceutico & { cantidad_ventas: number })[]> {
  const hasta = hoy();
  const filas = await farmaceuticos.activosConCantidadDeVentas(restarDias(hasta, DIAS), hasta);
  return filas.map(({ farmaceutico, cantidad }) => ({ ...farmaceutico, cantidad_ventas: cantidad }));
}
