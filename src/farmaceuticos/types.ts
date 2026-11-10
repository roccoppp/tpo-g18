export const CARGOS_FARMACEUTICO = ["Director Técnico", "Farmacéutico"] as const;

/** Neo4j: nodo `(:Farmaceutico)` (ver FarmaceuticosRepository). */
export interface Farmaceutico {
  id_farmaceutico: string;
  nombre: string;
  apellido: string;
  matricula: string;
  cargo: (typeof CARGOS_FARMACEUTICO)[number];
  /** Referencia a una sucursal (nodo de Neo4j). En el grafo es la relación TRABAJA_EN. */
  id_sucursal: string;
  activo: boolean;
}
