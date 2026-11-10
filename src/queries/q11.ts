import type { FarmaceuticosRepository } from "../farmaceuticos/repository.js";
import type { Farmaceutico } from "../farmaceuticos/types.js";
import { hoy, inicioDelMesSiguiente, inicioDeMes } from "../lib/fechas.js";
import type { VentasRepository } from "../ventas/repository.js";

/**
 * Q11: vista agregada de los ingresos totales por farmacéutico en el mes actual, considerando solo
 * las ventas 'Completada'.
 *
 * Motores: MongoDB y Neo4j, combinados en la aplicación. MongoDB agrega las ventas del mes (filtro
 * por estado y fecha con el índice `{estado, fecha}`, y `$group` por `id_farmaceutico`). Neo4j aporta
 * los datos de esos farmacéuticos, que viven solo en el grafo, en una única lectura por ids.
 *
 * "Mes actual" va del primer día del mes de hoy (inclusive) al primer día del mes siguiente
 * (exclusive), con la fecha del sistema. Solo aparecen los farmacéuticos con ventas completadas en
 * el mes, estén activos o no.
 *
 * Parámetros: ninguno.
 * @returns los datos de cada farmacéutico con `ingresos_totales` (ARS) y `cantidad_ventas`, de
 * mayor a menor ingreso y, a igual ingreso, por id.
 * @throws si una venta referencia un farmacéutico que no está en Neo4j.
 */
export async function q11IngresosPorFarmaceuticoMesActual(
  ventas: VentasRepository,
  farmaceuticos: FarmaceuticosRepository,
): Promise<(Farmaceutico & { ingresos_totales: number; cantidad_ventas: number })[]> {
  const fecha = hoy();
  const ingresos = await ventas.ingresosPorFarmaceutico(
    inicioDeMes(fecha),
    inicioDelMesSiguiente(fecha),
  );
  const ids = ingresos.map((fila) => fila.id_farmaceutico);
  const porId = new Map(
    (await farmaceuticos.buscarPorIds(ids)).map((f) => [f.id_farmaceutico, f]),
  );

  return ingresos.map(({ id_farmaceutico, ingresos: total, cantidad_ventas }) => {
    const farmaceutico = porId.get(id_farmaceutico);
    if (!farmaceutico) throw new Error(`No existe en Neo4j el farmacéutico ${id_farmaceutico}`);
    return { ...farmaceutico, ingresos_totales: total, cantidad_ventas };
  });
}
