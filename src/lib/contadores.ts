import type { Db } from "mongodb";

// Ids correlativos con el formato del dataset (C009, V017, ...). Cada entidad tiene un contador en la
// colección `contadores`. `$inc` es atómico sobre un documento, así que dos altas simultáneas nunca
// reciben el mismo número. Un alta que se rechaza después de pedir su número deja un hueco en la
// numeración, igual que una secuencia de una base relacional.

/** Incrementa el contador y devuelve el número nuevo. Si el contador no existe, lo crea en 1. */
export async function siguienteNumero(db: Db, contador: string): Promise<number> {
  const documento = await db
    .collection<{ _id: string; ultimo: number }>("contadores")
    .findOneAndUpdate(
      { _id: contador },
      { $inc: { ultimo: 1 } },
      { upsert: true, returnDocument: "after" },
    );
  if (!documento) throw new Error(`No se pudo incrementar el contador ${contador}`);
  return documento.ultimo;
}

/**
 * Fija el contador en el número más alto entre `ids` con el formato `<prefijo><número>`. Lo usa la
 * carga después de escribir una entidad, para que el próximo alta no choque con un id cargado.
 */
export async function fijarContador(db: Db, contador: string, prefijo: string, ids: string[]): Promise<void> {
  const formato = new RegExp(`^${prefijo}(\\d+)$`);
  const numeros = ids.map((id) => Number(formato.exec(id)?.[1] ?? 0));
  await db
    .collection<{ _id: string; ultimo: number }>("contadores")
    .updateOne({ _id: contador }, { $set: { ultimo: Math.max(0, ...numeros) } }, { upsert: true });
}

/** Da formato a un id: prefijo y número con al menos 3 dígitos (C001, C010, C100, C1000). */
export function formatearId(prefijo: string, numero: number): string {
  return `${prefijo}${String(numero).padStart(3, "0")}`;
}
