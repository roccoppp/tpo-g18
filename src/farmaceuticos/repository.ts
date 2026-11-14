import neo4j, { type Driver, type Node } from "neo4j-driver";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import { sucursalDesdeNodo } from "../sucursales/repository.js";
import type { Sucursal } from "../sucursales/types.js";
import type { Farmaceutico } from "./types.js";

// Cada farmacéutico es un nodo (:Farmaceutico). Neo4j es su única copia: ningún servicio escribe
// farmacéuticos. En el grafo, `id_sucursal` no es una propiedad: es la relación
// (:Farmaceutico)-[:TRABAJA_EN]->(:Sucursal). Las ventas lo referencian con
// (:Venta)-[:ATENDIDA_POR]->(:Farmaceutico).

/** Acceso a farmacéuticos. Motor: Neo4j, nodos `(:Farmaceutico)`. */
export class FarmaceuticosRepository {
  constructor(private readonly neo4j: Driver) {}

  /**
   * Reemplaza todos los farmacéuticos en una única transacción (carga idempotente), cada uno unido
   * a su sucursal. Los que siguen existiendo se actualizan en su lugar (MERGE), así que conservan
   * las relaciones que les llegan desde las ventas. Si alguna sucursal no existe, la transacción se
   * aborta: ningún farmacéutico queda sin su relación.
   */
  async reemplazarTodos(farmaceuticos: Farmaceutico[]): Promise<void> {
    await asegurarIdUnico(this.neo4j, "Farmaceutico", "id_farmaceutico");
    await enTransaccion(this.neo4j, async (tx) => {
      await tx.run("MATCH (f:Farmaceutico) WHERE NOT f.id_farmaceutico IN $ids DETACH DELETE f", {
        ids: farmaceuticos.map((farmaceutico) => farmaceutico.id_farmaceutico),
      });
      const { records } = await tx.run(
        `UNWIND $farmaceuticos AS fila
         MERGE (f:Farmaceutico {id_farmaceutico: fila.nodo.id_farmaceutico})
         SET f = fila.nodo
         WITH f, fila
         OPTIONAL MATCH (f)-[anterior:TRABAJA_EN]->()
         DELETE anterior
         WITH DISTINCT f, fila.id_sucursal AS idSucursal
         MATCH (s:Sucursal {id_sucursal: idSucursal})
         CREATE (f)-[:TRABAJA_EN]->(s)
         RETURN count(*) AS relacionados`,
        {
          farmaceuticos: farmaceuticos.map((farmaceutico) => ({
            nodo: aNodo(farmaceutico),
            id_sucursal: farmaceutico.id_sucursal,
          })),
        },
      );
      const relacionados: number = records[0].get("relacionados");
      if (relacionados !== farmaceuticos.length) {
        throw new Error(
          `Neo4j: solo ${relacionados} de ${farmaceuticos.length} farmacéuticos encontraron su sucursal`,
        );
      }
    });
  }

  /** Los farmacéuticos con esos ids, activos o no. Los ids que no existen no aparecen. */
  async buscarPorIds(ids: string[]): Promise<Farmaceutico[]> {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (f:Farmaceutico)-[:TRABAJA_EN]->(s:Sucursal)
       WHERE f.id_farmaceutico IN $ids
       RETURN f, s.id_sucursal AS idSucursal`,
      { ids },
      { routing: neo4j.routing.READ },
    );
    return records.map((registro) =>
      farmaceuticoDesdeNodo(registro.get("f"), registro.get("idSucursal")),
    );
  }

  /**
   * El farmacéutico con ese id, activo o no, junto con la sucursal donde trabaja (la que recorre
   * TRABAJA_EN). `null` si no existe.
   */
  async buscarConSucursal(
    idFarmaceutico: string,
  ): Promise<{ farmaceutico: Farmaceutico; sucursal: Sucursal } | null> {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (f:Farmaceutico {id_farmaceutico: $idFarmaceutico})-[:TRABAJA_EN]->(s:Sucursal)
       RETURN f, s`,
      { idFarmaceutico },
      { routing: neo4j.routing.READ },
    );
    const [registro] = records;
    if (!registro) return null;
    const sucursal = sucursalDesdeNodo(registro.get("s"));
    return { farmaceutico: farmaceuticoDesdeNodo(registro.get("f"), sucursal.id_sucursal), sucursal };
  }

  /**
   * Farmacéuticos activos con la cantidad de ventas no anuladas que atendieron
   * entre `desde` y `hasta` (ambas inclusive). Un único patrón en Neo4j: el `OPTIONAL MATCH` hace que
   * aparezcan también los que no atendieron ninguna, con cantidad 0. Ordena por cantidad (mayor
   * primero) y, a igual cantidad, por id.
   */
  async activosConCantidadDeVentas(
    desde: Date,
    hasta: Date,
  ): Promise<{ farmaceutico: Farmaceutico; cantidad: number }[]> {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (f:Farmaceutico {activo: true})-[:TRABAJA_EN]->(s:Sucursal)
       OPTIONAL MATCH (f)<-[:ATENDIDA_POR]-(v:Venta)
         WHERE v.fecha >= $desde AND v.fecha <= $hasta AND v.estado <> 'Anulada'
       RETURN f, s.id_sucursal AS idSucursal, count(v) AS cantidad
       ORDER BY cantidad DESC, f.id_farmaceutico`,
      {
        desde: neo4j.types.Date.fromStandardDateUTC(desde),
        hasta: neo4j.types.Date.fromStandardDateUTC(hasta),
      },
      { routing: neo4j.routing.READ },
    );
    return records.map((registro) => ({
      farmaceutico: farmaceuticoDesdeNodo(registro.get("f"), registro.get("idSucursal")),
      cantidad: registro.get("cantidad"),
    }));
  }
}

/** Propiedades del nodo (:Farmaceutico). La sucursal no se guarda acá: es la relación TRABAJA_EN. */
function aNodo(farmaceutico: Farmaceutico) {
  return {
    id_farmaceutico: farmaceutico.id_farmaceutico,
    nombre: farmaceutico.nombre,
    apellido: farmaceutico.apellido,
    matricula: farmaceutico.matricula,
    cargo: farmaceutico.cargo,
    activo: farmaceutico.activo,
  };
}

/**
 * Convierte un nodo (:Farmaceutico) al tipo del dominio. `idSucursal` sale de la relación
 * TRABAJA_EN, que la consulta recorre.
 */
export function farmaceuticoDesdeNodo(nodo: Node, idSucursal: string): Farmaceutico {
  const f = nodo.properties;
  return {
    id_farmaceutico: f.id_farmaceutico,
    nombre: f.nombre,
    apellido: f.apellido,
    matricula: f.matricula,
    cargo: f.cargo,
    id_sucursal: idSucursal,
    activo: f.activo,
  };
}
