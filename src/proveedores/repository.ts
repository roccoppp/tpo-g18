import type { Driver, Node } from "neo4j-driver";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import type { Proveedor } from "./types.js";

// Cada proveedor es un nodo (:Proveedor). Neo4j es su única copia: ningún servicio escribe
// proveedores. Los productos lo referencian con (:Producto)-[:PROVISTO_POR]->(:Proveedor).

/** Acceso a proveedores. Motor: Neo4j, nodos `(:Proveedor)`. */
export class ProveedoresRepository {
  constructor(private readonly neo4j: Driver) {}

  /**
   * Reemplaza todos los proveedores en una única transacción (carga idempotente). Los que siguen
   * existiendo se actualizan en su lugar (MERGE), así que conservan las relaciones que les llegan
   * desde los productos. Los que ya no están se borran junto con sus relaciones.
   */
  async reemplazarTodos(proveedores: Proveedor[]): Promise<void> {
    await asegurarIdUnico(this.neo4j, "Proveedor", "id_proveedor");
    await enTransaccion(this.neo4j, async (tx) => {
      await tx.run("MATCH (p:Proveedor) WHERE NOT p.id_proveedor IN $ids DETACH DELETE p", {
        ids: proveedores.map((proveedor) => proveedor.id_proveedor),
      });
      await tx.run(
        `UNWIND $proveedores AS fila
         MERGE (p:Proveedor {id_proveedor: fila.id_proveedor})
         SET p = fila`,
        { proveedores },
      );
    });
  }
}

/** Convierte un nodo (:Proveedor) al tipo del dominio. Lo usan las consultas que llegan a él. */
export function proveedorDesdeNodo(nodo: Node): Proveedor {
  const p = nodo.properties;
  return {
    id_proveedor: p.id_proveedor,
    razon_social: p.razon_social,
    cuit: p.cuit,
    tipo: p.tipo,
    ciudad: p.ciudad,
    provincia: p.provincia,
    telefono: p.telefono,
    activo: p.activo,
  };
}
