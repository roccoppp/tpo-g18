import type { ClientesRepository } from "../clientes/repository.js";
import type { Cliente } from "../clientes/types.js";

/**
 * Q10: todos los clientes atendidos en una sucursal determinada, a través del farmacéutico que
 * registró la venta, esté activo o no.
 *
 * Motor: Neo4j. Un único patrón que recorre las relaciones desde la sucursal hasta los clientes,
 *   (:Sucursal)<-[:TRABAJA_EN]-(:Farmaceutico)<-[:ATENDIDA_POR]-(:Venta)-[:DE_CLIENTE]->(:Cliente),
 * en un solo viaje. No filtra farmacéuticos por `activo`, y cuenta las ventas en cualquier estado:
 * una venta pendiente o anulada también es una atención. Incluye clientes dados de baja.
 *
 * @param idSucursal id de la sucursal.
 * @returns los clientes sin repetir, ordenados por id. Lista vacía si la sucursal no tiene ventas
 * (por ejemplo, la droguería).
 * @throws si no existe una sucursal con ese id.
 */
export async function q10ClientesDeSucursal(
  clientes: ClientesRepository,
  idSucursal: string,
): Promise<Cliente[]> {
  const atendidos = await clientes.atendidosEnSucursal(idSucursal);
  if (!atendidos) throw new Error(`No existe la sucursal ${idSucursal}`);
  return atendidos;
}
