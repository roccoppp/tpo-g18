export const TIPOS_PROVEEDOR = ["Laboratorio", "Droguería"] as const;

/** Neo4j: nodo `(:Proveedor)` (ver ProveedoresRepository). */
export interface Proveedor {
  id_proveedor: string;
  razon_social: string;
  cuit: string;
  tipo: (typeof TIPOS_PROVEEDOR)[number];
  ciudad: string;
  provincia: string;
  telefono: string;
  activo: boolean;
}
