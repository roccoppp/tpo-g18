import type { Driver, Node } from "neo4j-driver";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import type { Sucursal } from "./types.js";

// Cada sucursal es un nodo (:Sucursal). Neo4j es su única copia: ningún servicio escribe
// sucursales. Los lotes la referencian con (:Lote)-[:EN_SUCURSAL]->(:Sucursal).

/** Acceso a sucursales. Motor: Neo4j, nodos `(:Sucursal)`. */
export class SucursalesRepository {
  constructor(private readonly neo4j: Driver) {}

  /**
   * Reemplaza todas las sucursales en una única transacción (carga idempotente). Las que siguen
   * existiendo se actualizan en su lugar (MERGE), así que conservan las relaciones que les llegan.
   * Las que ya no están se borran junto con sus relaciones.
   */
  async reemplazarTodas(sucursales: Sucursal[]): Promise<void> {
    await asegurarIdUnico(this.neo4j, "Sucursal", "id_sucursal");
    await enTransaccion(this.neo4j, async (tx) => {
      await tx.run("MATCH (s:Sucursal) WHERE NOT s.id_sucursal IN $ids DETACH DELETE s", {
        ids: sucursales.map((sucursal) => sucursal.id_sucursal),
      });
      await tx.run(
        `UNWIND $sucursales AS fila
         MERGE (s:Sucursal {id_sucursal: fila.id_sucursal})
         SET s = fila`,
        { sucursales },
      );
    });
  }
}

/** Convierte un nodo (:Sucursal) al tipo del dominio. Lo usan las consultas que llegan a ella. */
export function sucursalDesdeNodo(nodo: Node): Sucursal {
  const s = nodo.properties;
  return {
    id_sucursal: s.id_sucursal,
    nombre: s.nombre,
    tipo: s.tipo,
    direccion: s.direccion,
    ciudad: s.ciudad,
    provincia: s.provincia,
    telefono: s.telefono,
    activo: s.activo,
  };
}
