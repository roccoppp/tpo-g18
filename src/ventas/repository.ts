import type { Collection, Db } from "mongodb";
import neo4j, { type Date as FechaNeo4j, type Driver, type Node } from "neo4j-driver";
import { farmaceuticoDesdeNodo } from "../farmaceuticos/repository.js";
import type { Farmaceutico } from "../farmaceuticos/types.js";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import { sucursalDesdeNodo } from "../sucursales/repository.js";
import type { Sucursal } from "../sucursales/types.js";
import type { Venta } from "./types.js";

// MongoDB es la fuente de verdad de las ventas: cada documento guarda la cabecera y sus ítems
// embebidos. Neo4j guarda una copia de la cabecera como nodo (:Venta) para recorrer sus relaciones.
// En el grafo, `id_farmaceutico` no es una propiedad: es la relación
// (:Venta)-[:ATENDIDA_POR]->(:Farmaceutico). Los ítems solo están en MongoDB.

/**
 * Acceso a ventas. Motores: MongoDB (colección `ventas`, fuente de verdad) y Neo4j (copia de la
 * cabecera como nodos `(:Venta)`).
 */
export class VentasRepository {
  private readonly coleccion: Collection<Venta>;

  constructor(
    db: Db,
    private readonly neo4j: Driver,
  ) {
    this.coleccion = db.collection<Venta>("ventas");
  }

  /**
   * Reemplaza todas las ventas (carga idempotente). Escribe primero en MongoDB, que es la fuente de
   * verdad, y después en la copia de Neo4j. Si la copia falla, se reconstruye con `npm run sync`.
   */
  async reemplazarTodas(ventas: Venta[]): Promise<void> {
    await this.coleccion.deleteMany({});
    if (ventas.length > 0) await this.coleccion.insertMany(ventas);
    await this.copiarAlGrafo(ventas);
  }

  /** Reconstruye la copia de Neo4j a partir de MongoDB (`npm run sync`). Devuelve cuántas copió. */
  async reconstruirCopia(): Promise<number> {
    const ventas = await this.coleccion.find().sort({ _id: 1 }).toArray();
    await this.copiarAlGrafo(ventas);
    return ventas.length;
  }

  /**
   * Cabeceras de las ventas en ese estado, con el farmacéutico que las atendió y la sucursal donde
   * trabaja, ordenadas por id. Un único patrón en Neo4j, que filtra con el índice sobre
   * `Venta.estado`.
   */
  async conFarmaceuticoEnEstado(estado: Venta["estado"]): Promise<
    {
      venta: Omit<Venta, "id_cliente" | "id_receta" | "items">;
      farmaceutico: Farmaceutico;
      sucursal: Sucursal;
    }[]
  > {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (v:Venta {estado: $estado})-[:ATENDIDA_POR]->(f:Farmaceutico)-[:TRABAJA_EN]->(s:Sucursal)
       RETURN v, f, s
       ORDER BY v.id_venta`,
      { estado },
      { routing: neo4j.routing.READ },
    );
    return records.map((registro) => {
      const sucursal = sucursalDesdeNodo(registro.get("s"));
      const farmaceutico = farmaceuticoDesdeNodo(registro.get("f"), sucursal.id_sucursal);
      const venta = cabeceraDesdeNodo(registro.get("v"), farmaceutico.id_farmaceutico);
      return { venta, farmaceutico, sucursal };
    });
  }

  /**
   * Deja en el grafo exactamente estas ventas, cada una unida a su farmacéutico, en una única
   * transacción. Si algún farmacéutico no existe, la transacción se aborta: ninguna venta queda sin
   * su relación.
   */
  private async copiarAlGrafo(ventas: Venta[]): Promise<void> {
    await asegurarIdUnico(this.neo4j, "Venta", "id_venta");
    await this.neo4j.executeQuery(
      "CREATE INDEX venta_estado IF NOT EXISTS FOR (v:Venta) ON (v.estado)",
    );
    await enTransaccion(this.neo4j, async (tx) => {
      await tx.run("MATCH (v:Venta) WHERE NOT v.id_venta IN $ids DETACH DELETE v", {
        ids: ventas.map((venta) => venta._id),
      });
      const { records } = await tx.run(
        `UNWIND $ventas AS fila
         MERGE (v:Venta {id_venta: fila.nodo.id_venta})
         SET v = fila.nodo
         WITH v, fila
         OPTIONAL MATCH (v)-[anterior:ATENDIDA_POR]->()
         DELETE anterior
         WITH DISTINCT v, fila.id_farmaceutico AS idFarmaceutico
         MATCH (f:Farmaceutico {id_farmaceutico: idFarmaceutico})
         CREATE (v)-[:ATENDIDA_POR]->(f)
         RETURN count(*) AS relacionados`,
        {
          ventas: ventas.map((venta) => ({
            nodo: aNodo(venta),
            id_farmaceutico: venta.id_farmaceutico,
          })),
        },
      );
      const relacionados: number = records[0].get("relacionados");
      if (relacionados !== ventas.length) {
        throw new Error(
          `Neo4j: solo ${relacionados} de ${ventas.length} ventas encontraron su farmacéutico`,
        );
      }
    });
  }
}

/**
 * Propiedades del nodo (:Venta). `total` se envía explícitamente como entero de Neo4j, y la fecha
 * como `date` de Neo4j, tomando el día en UTC (así lo construye la carga).
 */
function aNodo(venta: Venta) {
  return {
    id_venta: venta._id,
    fecha: neo4j.types.Date.fromStandardDateUTC(venta.fecha),
    tipo: venta.tipo,
    medio_pago: venta.medio_pago,
    total: neo4j.int(venta.total),
    estado: venta.estado,
  };
}

/**
 * Convierte un nodo (:Venta) en la cabecera de la venta. `idFarmaceutico` sale de la relación
 * ATENDIDA_POR, que la consulta recorre. El `date` de Neo4j vuelve como medianoche UTC.
 */
function cabeceraDesdeNodo(
  nodo: Node,
  idFarmaceutico: string,
): Omit<Venta, "id_cliente" | "id_receta" | "items"> {
  const v = nodo.properties;
  return {
    _id: v.id_venta,
    id_farmaceutico: idFarmaceutico,
    fecha: (v.fecha as FechaNeo4j<number>).toStandardDate(),
    tipo: v.tipo,
    medio_pago: v.medio_pago,
    total: v.total,
    estado: v.estado,
  };
}
