export const TIPOS_SUCURSAL = ["Farmacia", "Droguería"] as const;

/** Neo4j: nodo `(:Sucursal)` (ver SucursalesRepository). */
export interface Sucursal {
  id_sucursal: string;
  nombre: string;
  tipo: (typeof TIPOS_SUCURSAL)[number];
  direccion: string;
  ciudad: string;
  provincia: string;
  telefono: string;
  activo: boolean;
}
