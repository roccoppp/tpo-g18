import type { ClientesRepository } from "../clientes/repository.js";
import type { Cliente } from "../clientes/types.js";
import { hoy, restarAnios } from "../lib/fechas.js";

/**
 * Q12: clientes sin ventas registradas en el último año.
 *
 * Motor: Neo4j. Un único patrón negado sobre la copia de clientes y ventas: cada (:Cliente) para el
 * que no existe una (:Venta)-[:DE_CLIENTE]-> con fecha dentro del último año. Un `OPTIONAL MATCH`
 * agrega la fecha de su última venta, para distinguir a quien dejó de comprar de quien nunca compró.
 *
 * "Último año" va desde la misma fecha de hace un año hasta hoy, con la fecha del sistema. Cuenta
 * las ventas en cualquier estado (también pendientes y anuladas: quedaron registradas) e incluye
 * a los clientes dados de baja.
 *
 * Parámetros: ninguno.
 * @returns los datos de cada cliente con `ultima_venta` (null si nunca compró), ordenados por id.
 */
export async function q12ClientesSinVentasUltimoAnio(
  clientes: ClientesRepository,
): Promise<(Cliente & { ultima_venta: Date | null })[]> {
  const filas = await clientes.sinVentasDesde(restarAnios(hoy(), 1));
  return filas.map(({ cliente, ultimaVenta }) => ({ ...cliente, ultima_venta: ultimaVenta }));
}
