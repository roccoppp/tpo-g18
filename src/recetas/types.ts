export const TIPOS_RECETA = ["Simple", "Archivada", "Tratamiento prolongado"] as const;
export const ESTADOS_RECETA = ["Vigente", "Completada", "Vencida"] as const;

/** MongoDB: colección `recetas` (ver RecetasRepository). El `_id` es el id_receta del CSV. */
export interface Receta {
  _id: string;
  /** Referencia a un cliente. */
  id_cliente: string;
  medico: string;
  matricula_medico: string;
  fecha_emision: Date;
  tipo: (typeof TIPOS_RECETA)[number];
  dispensas_autorizadas: number;
  dispensas_realizadas: number;
  /** `null` si no corresponde una próxima dispensa. */
  proxima_dispensa: Date | null;
  estado: (typeof ESTADOS_RECETA)[number];
}
