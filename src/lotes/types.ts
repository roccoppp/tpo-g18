/**
 * MongoDB: colección `lotes` (fuente de verdad). El `_id` es el id_lote del CSV.
 * Copia en Neo4j: nodo `(:Lote)` (ver LotesRepository).
 */
export interface Lote {
  _id: string;
  /** Referencia a un producto. En el grafo es la relación DE_PRODUCTO. */
  id_producto: string;
  /** Referencia a una sucursal (nodo de Neo4j). En el grafo es la relación EN_SUCURSAL. */
  id_sucursal: string;
  nro_lote: string;
  /** Unidades disponibles. Nunca negativas. */
  unidades: number;
  /** Se guarda como fecha de BSON para ordenar por vencimiento (FEFO) y compararlo con hoy. */
  vencimiento: Date;
}
