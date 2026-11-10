import type { Collection, Db } from "mongodb";
import neo4j, { type Date as FechaNeo4j, type Driver, type Node } from "neo4j-driver";
import { farmaceuticoDesdeNodo } from "../farmaceuticos/repository.js";
import type { Farmaceutico } from "../farmaceuticos/types.js";
import type { Producto } from "../productos/types.js";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import { sucursalDesdeNodo } from "../sucursales/repository.js";
import type { Sucursal } from "../sucursales/types.js";
import type { Venta } from "./types.js";

// MongoDB es la fuente de verdad de las ventas: cada documento guarda la cabecera y sus ítems
// embebidos. Neo4j guarda una copia de la cabecera como nodo (:Venta) para recorrer sus relaciones.
// En el grafo, `id_farmaceutico` e `id_cliente` no son propiedades: son las relaciones
// (:Venta)-[:ATENDIDA_POR]->(:Farmaceutico) y (:Venta)-[:DE_CLIENTE]->(:Cliente). Los ítems solo
// están en MongoDB.

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
   * Reemplaza todas las ventas (carga idempotente) y asegura los índices que usan las consultas:
   * `{id_cliente, fecha}` para `deCliente`, `{estado, fecha}` para las agregaciones que filtran por
   * estado y período, y `{tipo, total}` para `noAnuladasDeTipoConTotalMenorA`. Escribe primero en MongoDB, que es la fuente de verdad, y después en la copia
   * de Neo4j. Si la copia falla, se reconstruye con `npm run sync`.
   */
  async reemplazarTodas(ventas: Venta[]): Promise<void> {
    await this.coleccion.deleteMany({});
    if (ventas.length > 0) await this.coleccion.insertMany(ventas);
    await this.coleccion.createIndex({ id_cliente: 1, fecha: 1 });
    await this.coleccion.createIndex({ estado: 1, fecha: 1 });
    await this.coleccion.createIndex({ tipo: 1, total: 1 });
    await this.copiarAlGrafo(ventas);
  }

  /** Reconstruye la copia de Neo4j a partir de MongoDB (`npm run sync`). Devuelve cuántas copió. */
  async reconstruirCopia(): Promise<number> {
    const ventas = await this.coleccion.find().sort({ _id: 1 }).toArray();
    await this.copiarAlGrafo(ventas);
    return ventas.length;
  }

  /** Ventas de un cliente con sus ítems, de la más antigua a la más reciente. */
  async deCliente(idCliente: string): Promise<Venta[]> {
    return this.coleccion.find({ id_cliente: idCliente }).sort({ fecha: 1, _id: 1 }).toArray();
  }

  /**
   * Ventas no anuladas del tipo dado con total menor a `maximo`, con sus ítems, de la más antigua a
   * la más reciente. Filtra con el índice `{tipo, total}`.
   */
  async noAnuladasDeTipoConTotalMenorA(tipo: Venta["tipo"], maximo: number): Promise<Venta[]> {
    return this.coleccion
      .find({ tipo, total: { $lt: maximo }, estado: { $ne: "Anulada" } })
      .sort({ fecha: 1, _id: 1 })
      .toArray();
  }

  /**
   * Los `limite` productos con más unidades vendidas en ventas 'Completada', con los datos de cada
   * producto. Un único pipeline: filtra por estado (índice `{estado, fecha}`), desarma los ítems
   * embebidos con `$unwind`, suma las cantidades por producto y trae el producto con `$lookup` sobre
   * `productos`. A igual cantidad de unidades, ordena por id de producto.
   */
  async productosMasVendidos(limite: number): Promise<{ producto: Producto; unidades: number }[]> {
    return this.coleccion
      .aggregate<{ producto: Producto; unidades: number }>([
        { $match: { estado: "Completada" } },
        { $unwind: "$items" },
        { $group: { _id: "$items.id_producto", unidades: { $sum: "$items.cantidad" } } },
        { $sort: { unidades: -1, _id: 1 } },
        { $limit: limite },
        { $lookup: { from: "productos", localField: "_id", foreignField: "_id", as: "producto" } },
        { $unwind: "$producto" },
        { $project: { _id: 0, producto: 1, unidades: 1 } },
      ])
      .toArray();
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
   * Deja en el grafo exactamente estas ventas, cada una unida a su farmacéutico y a su cliente, en
   * una única transacción. Si algún farmacéutico o cliente no existe, la transacción se aborta:
   * ninguna venta queda sin sus relaciones. Los clientes tienen que estar copiados antes.
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
         OPTIONAL MATCH (v)-[anterior:ATENDIDA_POR|DE_CLIENTE]->()
         DELETE anterior
         WITH DISTINCT v, fila.id_farmaceutico AS idFarmaceutico, fila.id_cliente AS idCliente
         MATCH (f:Farmaceutico {id_farmaceutico: idFarmaceutico})
         MATCH (c:Cliente {id_cliente: idCliente})
         CREATE (v)-[:ATENDIDA_POR]->(f), (v)-[:DE_CLIENTE]->(c)
         RETURN count(*) AS relacionados`,
        {
          ventas: ventas.map((venta) => ({
            nodo: aNodo(venta),
            id_farmaceutico: venta.id_farmaceutico,
            id_cliente: venta.id_cliente,
          })),
        },
      );
      const relacionados: number = records[0].get("relacionados");
      if (relacionados !== ventas.length) {
        throw new Error(
          `Neo4j: solo ${relacionados} de ${ventas.length} ventas encontraron su farmacéutico y su cliente`,
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
