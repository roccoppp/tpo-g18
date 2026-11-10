import type { Farmaceutico } from "../farmaceuticos/types.js";
import type { Sucursal } from "../sucursales/types.js";
import type { VentasRepository } from "../ventas/repository.js";
import type { Venta } from "../ventas/types.js";

/**
 * Q02: ventas en estado 'Pendiente' con el farmacéutico asignado (nombre, matrícula y sucursal) y
 * el total.
 *
 * Motor: Neo4j. Se resuelve con un único patrón,
 *   (:Venta {estado: 'Pendiente'})-[:ATENDIDA_POR]->(:Farmaceutico)-[:TRABAJA_EN]->(:Sucursal),
 * sobre la copia de las ventas en el grafo: un solo viaje, sin combinar en la aplicación.
 *
 * Parámetros: ninguno.
 * @returns la cabecera de cada venta (incluye `total`) con `farmaceutico` y `sucursal`, ordenadas
 * por id.
 */
export async function q02VentasPendientesConFarmaceutico(ventas: VentasRepository): Promise<
  (Omit<Venta, "id_cliente" | "id_receta" | "items"> & {
    farmaceutico: Farmaceutico;
    sucursal: Sucursal;
  })[]
> {
  const filas = await ventas.conFarmaceuticoEnEstado("Pendiente");
  return filas.map(({ venta, farmaceutico, sucursal }) => ({ ...venta, farmaceutico, sucursal }));
}
