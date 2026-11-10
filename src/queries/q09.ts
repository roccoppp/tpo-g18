import type { VentasRepository } from "../ventas/repository.js";
import type { Venta } from "../ventas/types.js";

/** La consulta pide las ventas con total menor a este importe (ARS). */
const TOTAL_MAXIMO = 5_000;

/**
 * Q09: ventas de tipo 'Venta libre' con total menor a $5.000, excluyendo las anuladas.
 *
 * Motor: MongoDB. Un `find` sobre `ventas` que filtra con el índice `{tipo, total}` y descarta las
 * anuladas. No cruza otras entidades: los ítems de cada venta están embebidos. Una venta de
 * exactamente $5.000 no entra: el total tiene que ser menor.
 *
 * Parámetros: ninguno.
 * @returns las ventas con sus ítems, de la más antigua a la más reciente.
 */
export async function q09VentasLibresMenoresA5000(ventas: VentasRepository): Promise<Venta[]> {
  return ventas.noAnuladasDeTipoConTotalMenorA("Venta libre", TOTAL_MAXIMO);
}
