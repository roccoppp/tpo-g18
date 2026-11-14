import type { ClientSession } from "mongodb";
import { OperacionRechazada } from "../lib/errores.js";
import { hoy } from "../lib/fechas.js";
import type { Repositorios } from "../lib/repositorios.js";
import type { Lote } from "../lotes/types.js";
import type { Venta } from "../ventas/types.js";

// Q15: actualización masiva del stock a partir de una venta registrada.
//
// Motores: MongoDB (ventas y lotes, la fuente de verdad del stock) y Neo4j (la sucursal del
// farmacéutico, que solo está en el grafo, y la copia de los lotes). El descuento de todos los
// ítems y la marca de la venta se escriben en una única transacción de MongoDB: o se descuenta todo
// o nada. Después de confirmarla se actualizan las unidades de los lotes en Neo4j.

/**
 * Q15: descuenta el stock de una venta registrada en los lotes de la sucursal del farmacéutico que
 * la atendió, con criterio FEFO y omitiendo los lotes vencidos (ver LotesRepository.descontarFefo).
 *
 * Rechaza la operación si la venta no existe, si no está 'Completada' (una venta 'Pendiente' o
 * 'Anulada' no descuenta stock) o si su stock ya se descontó. Si el stock vigente no alcanza para
 * algún ítem, rechaza la operación completa sin modificar ningún lote.
 *
 * @param idVenta la venta cuyo stock se descuenta.
 * @returns la venta y cada lote modificado, antes y después del descuento.
 */
export async function q15DescontarStock(
  repos: Pick<Repositorios, "ventas" | "farmaceuticos" | "lotes" | "transacciones">,
  idVenta: string,
): Promise<{ venta: Venta; lotes: { antes: Lote; despues: Lote }[] }> {
  const resultado = await repos.transacciones.ejecutar((session) =>
    descontarStockDeVenta(repos, idVenta, session),
  );
  await repos.lotes.copiarUnidades(resultado.lotes.map((lote) => lote.despues));
  return resultado;
}

/**
 * La parte de q15 que escribe en MongoDB, dentro de la transacción de `session`. La usa q15 y
 * también q14, que la ejecuta en su propia transacción para que la venta, la receta y el stock
 * se confirmen juntos. No actualiza la copia de Neo4j: eso lo hace quien llama, después de
 * confirmar la transacción.
 */
export async function descontarStockDeVenta(
  { ventas, farmaceuticos, lotes }: Pick<Repositorios, "ventas" | "farmaceuticos" | "lotes">,
  idVenta: string,
  session: ClientSession,
): Promise<{ venta: Venta; lotes: { antes: Lote; despues: Lote }[] }> {
  const venta = await ventas.buscarPorId(idVenta, session);
  if (!venta) throw new OperacionRechazada(`no existe la venta ${idVenta}`);
  if (venta.estado !== "Completada") {
    throw new OperacionRechazada(
      `la venta ${idVenta} está '${venta.estado}': solo una venta 'Completada' descuenta stock`,
    );
  }
  if (venta.stock_descontado) {
    throw new OperacionRechazada(`el stock de la venta ${idVenta} ya se descontó`);
  }
  const encontrado = await farmaceuticos.buscarConSucursal(venta.id_farmaceutico);
  if (!encontrado) {
    throw new OperacionRechazada(`no existe el farmacéutico ${venta.id_farmaceutico} de la venta`);
  }
  const modificados = await lotes.descontarFefo(
    encontrado.sucursal.id_sucursal,
    venta.items,
    hoy(),
    session,
  );
  await ventas.marcarStockDescontado(idVenta, session);
  return { venta: { ...venta, stock_descontado: true }, lotes: modificados };
}
