export const CONDICIONES_VENTA = ["Venta libre", "Bajo receta", "Bajo receta archivada"] as const;

/**
 * MongoDB: colección `productos` (fuente de verdad). El `_id` es el id_producto del CSV.
 * Copia en Neo4j: nodo `(:Producto)` (ver ProductosRepository).
 */
export interface Producto {
  _id: string;
  nombre: string;
  principio_activo: string;
  categoria: string;
  presentacion: string;
  condicion_venta: (typeof CONDICIONES_VENTA)[number];
  precio_unit: number;
  /** Referencia a un proveedor (nodo de Neo4j). En el grafo es la relación PROVISTO_POR. */
  id_proveedor: string;
  activo: boolean;
}
