export const TIPOS_VENTA = ["Venta libre", "Con receta"] as const;
export const MEDIOS_PAGO = ["Efectivo", "Débito", "Crédito", "Transferencia", "Obra social"] as const;
export const ESTADOS_VENTA = ["Completada", "Pendiente", "Anulada"] as const;

/** Un ítem de la venta. Va embebido en el documento de la venta. */
export interface ItemVenta {
  id_detalle: string;
  /** Referencia a un producto. */
  id_producto: string;
  cantidad: number;
  /** Precio vigente al momento de la venta: puede diferir del precio de lista actual. */
  precio_unit: number;
}

/**
 * MongoDB: colección `ventas` (fuente de verdad). El `_id` es el id_venta del CSV.
 * Copia en Neo4j: nodo `(:Venta)` con los datos de la cabecera (ver VentasRepository).
 */
export interface Venta {
  _id: string;
  /** Referencia a un cliente. */
  id_cliente: string;
  /** Referencia a un farmacéutico (nodo de Neo4j). En el grafo es la relación ATENDIDA_POR. */
  id_farmaceutico: string;
  /** Referencia a una receta. `null` en las ventas libres. */
  id_receta: string | null;
  fecha: Date;
  tipo: (typeof TIPOS_VENTA)[number];
  medio_pago: (typeof MEDIOS_PAGO)[number];
  /** Suma de cantidad × precio_unit de los ítems. */
  total: number;
  estado: (typeof ESTADOS_VENTA)[number];
  items: ItemVenta[];
}
