export const TIPOS_PROVEEDOR = ["Laboratorio", "Droguería"] as const;

/** Redis: hash `proveedor:<id_proveedor>` (ver ProveedoresRepository). */
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
