import type { ClientesRepository } from "../clientes/repository.js";
import type { RecetasRepository } from "../recetas/repository.js";
import type { Receta } from "../recetas/types.js";
import type { VentasRepository } from "../ventas/repository.js";
import type { Venta } from "../ventas/types.js";

/**
 * Q03: historial completo de un cliente: sus ventas y sus recetas, ordenadas cronológicamente.
 *
 * Motor: MongoDB. Filtra `ventas` y `recetas` por `id_cliente`, cada una con su índice compuesto
 * sobre cliente y fecha, y la aplicación intercala los dos resultados ya ordenados. Las ventas
 * traen sus ítems embebidos.
 *
 * @param idCliente id del cliente. Se aceptan clientes dados de baja: el historial se conserva.
 * @returns ventas y recetas de la más antigua a la más reciente. `registro` indica qué es cada
 * elemento y `fecha` es la fecha de la venta o la de emisión de la receta. A igual fecha, la receta
 * va antes que la venta. Es una lista vacía si el cliente no tiene ventas ni recetas.
 * @throws si no existe un cliente con ese id.
 */
export async function q03HistorialCliente(
  clientes: ClientesRepository,
  ventas: VentasRepository,
  recetas: RecetasRepository,
  idCliente: string,
): Promise<(({ registro: "venta" } & Venta) | ({ registro: "receta"; fecha: Date } & Receta))[]> {
  const [cliente, ventasCliente, recetasCliente] = await Promise.all([
    clientes.buscarPorId(idCliente),
    ventas.deCliente(idCliente),
    recetas.deCliente(idCliente),
  ]);
  if (!cliente) throw new Error(`No existe el cliente ${idCliente}`);

  // Las recetas van primero porque el ordenamiento es estable: define el desempate por fecha.
  const historial = [
    ...recetasCliente.map((receta) => ({
      registro: "receta" as const,
      fecha: receta.fecha_emision,
      ...receta,
    })),
    ...ventasCliente.map((venta) => ({ registro: "venta" as const, ...venta })),
  ];
  return historial.sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
}
