import type { Collection, Db } from "mongodb";
import neo4j, { type Date as FechaNeo4j, type Driver, type Node } from "neo4j-driver";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import { productoDesdeNodo } from "../productos/repository.js";
import type { Producto } from "../productos/types.js";
import { proveedorDesdeNodo } from "../proveedores/repository.js";
import type { Proveedor } from "../proveedores/types.js";
import { sucursalDesdeNodo } from "../sucursales/repository.js";
import type { Sucursal } from "../sucursales/types.js";
import type { Lote } from "./types.js";

// MongoDB es la fuente de verdad del stock: ahí ocurren los descuentos de q15, dentro de una
// transacción. Neo4j guarda una copia de cada lote como nodo (:Lote) para recorrer sus relaciones.
// En el grafo, `id_producto` e `id_sucursal` no son propiedades: son las relaciones
// (:Lote)-[:DE_PRODUCTO]->(:Producto) y (:Lote)-[:EN_SUCURSAL]->(:Sucursal).

/**
 * Acceso a lotes de stock. Motores: MongoDB (colección `lotes`, fuente de verdad) y Neo4j (copia
 * como nodos `(:Lote)`).
*/
export class LotesRepository {
  private readonly coleccion: Collection<Lote>;

  constructor(
    db: Db,
    private readonly neo4j: Driver,
  ) {
    this.coleccion = db.collection<Lote>("lotes");
  }

  /**
   * Reemplaza todos los lotes (carga idempotente). Escribe primero en MongoDB, que es la fuente de
   * verdad, y después en la copia de Neo4j. Si la copia falla, se reconstruye con `npm run sync`.
  */
  async reemplazarTodos(lotes: Lote[]): Promise<void> {
    await this.coleccion.deleteMany({});
    if (lotes.length > 0) await this.coleccion.insertMany(lotes);
    await this.copiarAlGrafo(lotes);
  }

  /** Reconstruye la copia de Neo4j a partir de MongoDB (`npm run sync`). Devuelve cuántos copió. */
  async reconstruirCopia(): Promise<number> {
    const lotes = await this.coleccion.find().sort({ _id: 1 }).toArray();
    await this.copiarAlGrafo(lotes);
    return lotes.length;
  }

  /**
   * Lotes con menos de `limite` unidades, con su producto, su sucursal y el proveedor del producto,
   * ordenados por id. Un único patrón en Neo4j, que filtra con el índice sobre `Lote.unidades`.
   */
  async conMenosUnidadesQue(
    limite: number,
  ): Promise<{ lote: Lote; producto: Producto; sucursal: Sucursal; proveedor: Proveedor }[]> {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (l:Lote)-[:DE_PRODUCTO]->(p:Producto)-[:PROVISTO_POR]->(pr:Proveedor),
             (l)-[:EN_SUCURSAL]->(s:Sucursal)
       WHERE l.unidades < $limite
       RETURN l, p, s, pr
       ORDER BY l.id_lote`,
      { limite: neo4j.int(limite) },
      { routing: neo4j.routing.READ },
    );
    return records.map((registro) => {
      const proveedor = proveedorDesdeNodo(registro.get("pr"));
      const producto = productoDesdeNodo(registro.get("p"), proveedor.id_proveedor);
      const sucursal = sucursalDesdeNodo(registro.get("s"));
      const lote = loteDesdeNodo(registro.get("l"), producto._id, sucursal.id_sucursal);
      return { lote, producto, sucursal, proveedor };
    });
  }

  /**
   * Deja en el grafo exactamente estos lotes, cada uno unido a su producto y a su sucursal, en una
   * única transacción. Si algún producto o sucursal no existe, la transacción se aborta: ningún
   * lote queda sin sus relaciones.
   */
  private async copiarAlGrafo(lotes: Lote[]): Promise<void> {
    await asegurarIdUnico(this.neo4j, "Lote", "id_lote");
    await this.neo4j.executeQuery(
      "CREATE INDEX lote_unidades IF NOT EXISTS FOR (l:Lote) ON (l.unidades)",
    );
    await enTransaccion(this.neo4j, async (tx) => {
      await tx.run("MATCH (l:Lote) WHERE NOT l.id_lote IN $ids DETACH DELETE l", {
        ids: lotes.map((lote) => lote._id),
      });
      const { records } = await tx.run(
        `UNWIND $lotes AS fila
         MERGE (l:Lote {id_lote: fila.nodo.id_lote})
         SET l = fila.nodo
         WITH l, fila
         OPTIONAL MATCH (l)-[anterior:DE_PRODUCTO|EN_SUCURSAL]->()
         DELETE anterior
         WITH DISTINCT l, fila.id_producto AS idProducto, fila.id_sucursal AS idSucursal
         MATCH (p:Producto {id_producto: idProducto}), (s:Sucursal {id_sucursal: idSucursal})
         CREATE (l)-[:DE_PRODUCTO]->(p), (l)-[:EN_SUCURSAL]->(s)
         RETURN count(*) AS relacionados`,
        {
          lotes: lotes.map((lote) => ({
            nodo: aNodo(lote),
            id_producto: lote.id_producto,
            id_sucursal: lote.id_sucursal,
          })),
        },
      );
      const relacionados: number = records[0].get("relacionados");
      if (relacionados !== lotes.length) {
        throw new Error(
          `Neo4j: solo ${relacionados} de ${lotes.length} lotes encontraron su producto y su sucursal`,
        );
      }
    });
  }
}

/**
 * Propiedades del nodo (:Lote). `unidades` se envía explícitamente como entero de Neo4j, y el
 * vencimiento como `date` de Neo4j, tomando el día en UTC (así lo construye la carga).
 */
function aNodo(lote: Lote) {
  return {
    id_lote: lote._id,
    nro_lote: lote.nro_lote,
    unidades: neo4j.int(lote.unidades),
    vencimiento: neo4j.types.Date.fromStandardDateUTC(lote.vencimiento),
  };
}

/**
 * Convierte un nodo (:Lote) al tipo del dominio. `idProducto` e `idSucursal` salen de las
 * relaciones que la consulta recorre. El `date` de Neo4j vuelve como medianoche UTC.
 */
function loteDesdeNodo(nodo: Node, idProducto: string, idSucursal: string): Lote {
  const l = nodo.properties;
  return {
    _id: l.id_lote,
    id_producto: idProducto,
    id_sucursal: idSucursal,
    nro_lote: l.nro_lote,
    unidades: l.unidades,
    vencimiento: (l.vencimiento as FechaNeo4j<number>).toStandardDate(),
  };
}
