import type { Collection, Db } from "mongodb";
import neo4j, { type Driver, type Node } from "neo4j-driver";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import { proveedorDesdeNodo } from "../proveedores/repository.js";
import type { Proveedor } from "../proveedores/types.js";
import type { Producto } from "./types.js";

// MongoDB es la fuente de verdad del catálogo. Neo4j guarda una copia de cada producto como nodo
// (:Producto) para recorrer sus relaciones. En el grafo, `id_proveedor` no es una propiedad:
// es la relación (:Producto)-[:PROVISTO_POR]->(:Proveedor).

/**
 * Acceso a productos. Motores: MongoDB (colección `productos`, fuente de verdad) y Neo4j (copia
 * como nodos `(:Producto)`).
 */
export class ProductosRepository {
  private readonly coleccion: Collection<Producto>;

  constructor(
    db: Db,
    private readonly neo4j: Driver,
  ) {
    this.coleccion = db.collection<Producto>("productos");
  }

  /**
   * Reemplaza todo el catálogo (carga idempotente). Escribe primero en MongoDB, que es la fuente de
   * verdad, y después en la copia de Neo4j. Si la copia falla, se reconstruye con `npm run sync`.
   */
  async reemplazarTodos(productos: Producto[]): Promise<void> {
    await this.coleccion.deleteMany({});
    if (productos.length > 0) await this.coleccion.insertMany(productos);
    await this.copiarAlGrafo(productos);
  }

  /** Reconstruye la copia de Neo4j a partir de MongoDB (`npm run sync`). Devuelve cuántos copió. */
  async reconstruirCopia(): Promise<number> {
    const productos = await this.coleccion.find().sort({ _id: 1 }).toArray();
    await this.copiarAlGrafo(productos);
    return productos.length;
  }

  /** Productos con `activo: true` y su proveedor, ordenados por id. Un único patrón en Neo4j. */
  async activosConProveedor(): Promise<{ producto: Producto; proveedor: Proveedor }[]> {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (p:Producto {activo: true})-[:PROVISTO_POR]->(pr:Proveedor)
       RETURN p, pr
       ORDER BY p.id_producto`,
      {},
      { routing: neo4j.routing.READ },
    );
    return records.map((registro) => {
      const proveedor = proveedorDesdeNodo(registro.get("pr"));
      return { producto: productoDesdeNodo(registro.get("p"), proveedor.id_proveedor), proveedor };
    });
  }

  /**
   * Deja en el grafo exactamente estos productos, cada uno unido a su proveedor, en una única
   * transacción. Los productos que siguen existiendo se actualizan en su lugar (MERGE), así que
   * conservan las relaciones que les llegan desde los lotes. Si algún proveedor no existe, la
   * transacción se aborta: ningún producto queda sin su relación.
   */
  private async copiarAlGrafo(productos: Producto[]): Promise<void> {
    await asegurarIdUnico(this.neo4j, "Producto", "id_producto");
    await enTransaccion(this.neo4j, async (tx) => {
      await tx.run("MATCH (p:Producto) WHERE NOT p.id_producto IN $ids DETACH DELETE p", {
        ids: productos.map((producto) => producto._id),
      });
      const { records } = await tx.run(
        `UNWIND $productos AS fila
         MERGE (p:Producto {id_producto: fila.nodo.id_producto})
         SET p = fila.nodo
         WITH p, fila
         OPTIONAL MATCH (p)-[anterior:PROVISTO_POR]->()
         DELETE anterior
         WITH DISTINCT p, fila.id_proveedor AS idProveedor
         MATCH (pr:Proveedor {id_proveedor: idProveedor})
         CREATE (p)-[:PROVISTO_POR]->(pr)
         RETURN count(*) AS relacionados`,
        {
          productos: productos.map((producto) => ({
            nodo: aNodo(producto),
            id_proveedor: producto.id_proveedor,
          })),
        },
      );
      const relacionados: number = records[0].get("relacionados");
      if (relacionados !== productos.length) {
        throw new Error(
          `Neo4j: solo ${relacionados} de ${productos.length} productos encontraron su proveedor`,
        );
      }
    });
  }
}

/**
 * Propiedades del nodo (:Producto). JavaScript no distingue enteros de decimales, así que
 * `precio_unit` se envía explícitamente como entero de Neo4j.
 */
function aNodo(producto: Producto) {
  return {
    id_producto: producto._id,
    nombre: producto.nombre,
    principio_activo: producto.principio_activo,
    categoria: producto.categoria,
    presentacion: producto.presentacion,
    condicion_venta: producto.condicion_venta,
    precio_unit: neo4j.int(producto.precio_unit),
    activo: producto.activo,
  };
}

/**
 * Convierte un nodo (:Producto) al tipo del dominio. `idProveedor` sale de la relación
 * PROVISTO_POR, que la consulta recorre.
 */
export function productoDesdeNodo(nodo: Node, idProveedor: string): Producto {
  const p = nodo.properties;
  return {
    _id: p.id_producto,
    nombre: p.nombre,
    principio_activo: p.principio_activo,
    categoria: p.categoria,
    presentacion: p.presentacion,
    condicion_venta: p.condicion_venta,
    precio_unit: p.precio_unit,
    id_proveedor: idProveedor,
    activo: p.activo,
  };
}
