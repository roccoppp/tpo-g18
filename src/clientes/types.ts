export const OBRAS_SOCIALES = ["OSDE", "Swiss Medical", "PAMI", "IOMA", "Galeno", "Sin cobertura"] as const;

/** Obra social de quien no tiene cobertura: es la única que va sin número de afiliado. */
export const SIN_COBERTURA = "Sin cobertura";

/**
 * MongoDB: colección `clientes` (fuente de verdad), con índice único sobre `dni`. El `_id` es el
 * id_cliente del CSV. Copia en Neo4j: nodo `(:Cliente)` (ver ClientesRepository).
 */
export interface Cliente {
  _id: string;
  nombre: string;
  apellido: string;
  /** Documento nacional de identidad. Único entre todos los clientes, activos o dados de baja. */
  dni: string;
  email: string;
  telefono: string;
  ciudad: string;
  provincia: string;
  obra_social: (typeof OBRAS_SOCIALES)[number];
  /** Vacío (null) si y solo si la obra social es 'Sin cobertura'. */
  nro_afiliado: string | null;
  /** `false` indica baja lógica. */
  activo: boolean;
}

/**
 * Reglas de un cliente que no dependen de otros datos: campos obligatorios, formatos y coherencia
 * de la cobertura. Las aplican la carga y el ABM (q13). El DNI único no se valida acá: lo garantiza
 * el índice de MongoDB. Devuelve los problemas encontrados, o una lista vacía si no hay ninguno.
 */
export function problemasDeCliente(cliente: Omit<Cliente, "_id" | "activo">): string[] {
  const problemas: string[] = [];
  for (const campo of ["nombre", "apellido", "ciudad", "provincia"] as const) {
    if (!cliente[campo]?.trim()) problemas.push(`falta ${campo}`);
  }
  if (!/^\d{7,8}$/.test(cliente.dni ?? "")) {
    problemas.push(`dni "${cliente.dni ?? ""}" tiene que tener 7 u 8 dígitos`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cliente.email ?? "")) {
    problemas.push(`email "${cliente.email ?? ""}" no es válido`);
  }
  if (!/^\d{6,15}$/.test(cliente.telefono ?? "")) {
    problemas.push(`telefono "${cliente.telefono ?? ""}" tiene que tener solo dígitos (6 a 15)`);
  }
  const nroAfiliado = cliente.nro_afiliado || null;
  if (!OBRAS_SOCIALES.includes(cliente.obra_social)) {
    problemas.push(`obra_social tiene que ser una de: ${OBRAS_SOCIALES.join(", ")}`);
  } else if (cliente.obra_social === SIN_COBERTURA && nroAfiliado !== null) {
    problemas.push(`con '${SIN_COBERTURA}', nro_afiliado tiene que quedar vacío`);
  } else if (cliente.obra_social !== SIN_COBERTURA && nroAfiliado === null) {
    problemas.push(`con obra social ${cliente.obra_social}, falta nro_afiliado`);
  }
  return problemas;
}
