import type { RedisClient } from "../lib/db.js";
import type { Proveedor } from "./types.js";

// Cada proveedor es un hash `proveedor:<id_proveedor>`. Los hashes de Redis solo
// guardan strings, así que `activo` se guarda como "true"/"false".

const PREFIJO = "proveedor:";

/** Acceso a proveedores. Motor: Redis. */
export class ProveedoresRepository {
  constructor(private readonly redis: RedisClient) {}

  /** Reemplaza todos los proveedores en una única transacción MULTI (carga idempotente). */
  async reemplazarTodos(proveedores: Proveedor[]): Promise<void> {
    const existentes: string[] = [];
    for await (const claves of this.redis.scanIterator({ MATCH: `${PREFIJO}*`, COUNT: 100 })) {
      existentes.push(...claves);
    }
    const tx = this.redis.multi();
    if (existentes.length > 0) tx.del(existentes);
    for (const proveedor of proveedores) {
      tx.hSet(clave(proveedor.id_proveedor), aHash(proveedor));
    }
    await tx.exec();
  }

  /**
   * Busca varios proveedores por id. node-redis agrupa en un pipeline los comandos
   * emitidos en el mismo tick, así que todos los HGETALL viajan juntos.
   * Los ids que no existen en Redis quedan fuera del mapa.
   */
  async obtenerVarios(ids: Iterable<string>): Promise<Map<string, Proveedor>> {
    const unicos = [...new Set(ids)];
    const hashes = await Promise.all(unicos.map((id) => this.redis.hGetAll(clave(id))));
    const proveedores = new Map<string, Proveedor>();
    for (const hash of hashes) {
      const proveedor = desdeHash(hash);
      if (proveedor) proveedores.set(proveedor.id_proveedor, proveedor);
    }
    return proveedores;
  }
}

function clave(id: string): string {
  return `${PREFIJO}${id}`;
}

function aHash(proveedor: Proveedor): Record<string, string> {
  return { ...proveedor, activo: String(proveedor.activo) };
}

function desdeHash(hash: Record<string, string>): Proveedor | null {
  if (Object.keys(hash).length === 0) return null;
  return {
    id_proveedor: hash.id_proveedor,
    razon_social: hash.razon_social,
    cuit: hash.cuit,
    tipo: hash.tipo as Proveedor["tipo"],
    ciudad: hash.ciudad,
    provincia: hash.provincia,
    telefono: hash.telefono,
    activo: hash.activo === "true",
  };
}
