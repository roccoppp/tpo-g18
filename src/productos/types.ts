export const CONDICIONES_VENTA = ["Venta libre", "Bajo receta", "Bajo receta archivada"] as const;

/** MongoDB: colección `productos`. El `_id` es el id_producto del CSV. */
export interface Producto {
  _id: string;
  nombre: string;
  principio_activo: string;
  categoria: string;
  presentacion: string;
  condicion_venta: (typeof CONDICIONES_VENTA)[number];
  precio_unit: number;
  /** Referencia a un proveedor en Redis. */
  id_proveedor: string;
  activo: boolean;
}
