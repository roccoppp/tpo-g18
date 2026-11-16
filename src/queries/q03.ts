import type { ClientesRepository } from "../clientes/repository.js";
import type { Receta } from "../recetas/types.js";
import type { ItemVenta, Venta } from "../ventas/types.js";

/**
 * Q03: historial completo de un cliente: sus ventas y sus recetas, ordenadas cronológicamente.
 *
 * Motor: Neo4j. Un único patrón que parte del nodo del cliente y recorre la red
 * cliente–receta–venta–producto: (:Receta)-[:EMITIDA_PARA]->(:Cliente) y
 * (:Venta)-[:DE_CLIENTE]->(:Cliente), y desde cada venta su farmacéutico (ATENDIDA_POR), la receta
 * con la que se dispensó (CON_RECETA) y sus productos (INCLUYE). El grafo devuelve el historial ya
 * ordenado (ver ClientesRepository.historial).
 *
 * @param idCliente id del cliente. Se aceptan clientes dados de baja: el historial se conserva.
 * @returns ventas y recetas de la más antigua a la más reciente. `registro` indica qué es cada
 * elemento y `fecha` es la fecha de la venta o la de emisión de la receta. A igual fecha, la receta
 * va antes que la venta. Cada ítem de una venta trae el nombre del producto. Las ventas no traen
 * `stock_descontado`, que solo está en MongoDB. Es una lista vacía si el cliente no tiene ventas ni
 * recetas.
 * @throws si no existe un cliente con ese id.
 */
export async function q03HistorialCliente(
  clientes: ClientesRepository,
  idCliente: string,
): Promise<
  (
    | ({ registro: "receta"; fecha: Date } & Receta)
    | ({ registro: "venta" } & Omit<Venta, "stock_descontado" | "items"> & {
          items: (ItemVenta & { nombre_producto: string })[];
        })
  )[]
> {
  const historial = await clientes.historial(idCliente);
  if (!historial) throw new Error(`No existe el cliente ${idCliente}`);
  return historial;
}
